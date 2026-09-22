import { Router } from 'express';
import { z } from 'zod';
import { seasonOfMonth, wearLogBatchSchema, wearLogSchema } from '@gml/shared';
import { HttpError } from '../lib/errors.js';
import { created, handler, ok, parseBody, parseQuery } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { parseDateOnly } from '../lib/date.js';
import { isUniqueViolation } from '../lib/prisma-errors.js';
import { requireAuth } from '../middleware/auth.js';

export const wearRouter = Router();
wearRouter.use(requireAuth);

wearRouter.post(
  '/',
  handler(async (req, res) => {
    const body = parseBody(wearLogSchema, req.body);
    const result = await recordWear(req.ctx.wardrobeId, req.ctx.userId, body);
    if (result.duplicate) {
      ok(req, res, result, { idempotent: true });
      return;
    }
    created(req, res, result);
  }),
);

wearRouter.post(
  '/batch',
  handler(async (req, res) => {
    const body = parseBody(wearLogBatchSchema, req.body);
    const results = [];
    for (const log of body.logs) {
      try {
        results.push({ ok: true, ...(await recordWear(req.ctx.wardrobeId, req.ctx.userId, log)) });
      } catch (error) {
        results.push({
          ok: false,
          garmentId: log.garmentId,
          wornOn: log.wornOn,
          error: error instanceof HttpError ? error.message : '同步失败',
        });
      }
    }
    ok(req, res, {
      results,
      created: results.filter((r) => r.ok && !('duplicate' in r && r.duplicate)).length,
      duplicates: results.filter((r) => r.ok && 'duplicate' in r && r.duplicate).length,
      failed: results.filter((r) => !r.ok).length,
    });
  }),
);

wearRouter.get(
  '/',
  handler(async (req, res) => {
    const query = parseQuery(
      z.object({
        garmentId: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
      req.query,
    );
    const logs = await prisma.wearLog.findMany({
      where: {
        garment: { wardrobeId: req.ctx.wardrobeId, deletedAt: null },
        ...(query.garmentId ? { garmentId: query.garmentId } : {}),
        ...(query.from || query.to
          ? {
              wornOn: {
                ...(query.from ? { gte: parseDateOnly(query.from) } : {}),
                ...(query.to ? { lte: parseDateOnly(query.to) } : {}),
              },
            }
          : {}),
      },
      include: { garment: { select: { id: true, code: true, name: true, materialPrimary: true } } },
      orderBy: { wornOn: 'desc' },
      take: query.limit,
    });
    ok(req, res, { logs });
  }),
);

wearRouter.get(
  '/calendar',
  handler(async (req, res) => {
    const query = parseQuery(
      z.object({ month: z.string().regex(/^\d{4}-\d{2}$/u).optional(), garmentId: z.string().optional() }),
      req.query,
    );
    const month = query.month ?? new Date().toISOString().slice(0, 7);
    const [year, monthNum] = month.split('-').map(Number);
    const start = new Date(Date.UTC(year, monthNum - 1, 1));
    const end = new Date(Date.UTC(year, monthNum, 0));

    const logs = await prisma.wearLog.findMany({
      where: {
        garment: { wardrobeId: req.ctx.wardrobeId, deletedAt: null },
        wornOn: { gte: start, lte: end },
        ...(query.garmentId ? { garmentId: query.garmentId } : {}),
      },
      include: { garment: { select: { id: true, name: true, code: true, materialPrimary: true } } },
      orderBy: { wornOn: 'asc' },
    });

    const days: Record<string, Array<{ garmentId: string; name: string; session: string; intensity: string }>> = {};
    for (const log of logs) {
      const key = log.wornOn.toISOString().slice(0, 10);
      days[key] = days[key] ?? [];
      days[key].push({
        garmentId: log.garmentId,
        name: log.garment.name,
        session: log.session,
        intensity: log.intensity,
      });
    }

    const [garments, topGarments] = await Promise.all([
      prisma.garment.count({ where: { wardrobeId: req.ctx.wardrobeId, deletedAt: null, status: { not: 'retired' } } }),
      prisma.wearLog.groupBy({
        by: ['garmentId'],
        where: { garment: { wardrobeId: req.ctx.wardrobeId }, wornOn: { gte: start, lte: end } },
        _count: { _all: true },
        orderBy: { _count: { garmentId: 'desc' } },
        take: 5,
      }),
    ]);

    ok(req, res, {
      month,
      days,
      totals: {
        wearCount: logs.length,
        garmentCount: garments,
        distinctGarments: new Set(logs.map((l) => l.garmentId)).size,
        averagePerDay: Math.round((logs.length / end.getUTCDate()) * 100) / 100,
      },
      topGarments,
    });
  }),
);

wearRouter.delete(
  '/:id',
  handler(async (req, res) => {
    const log = await prisma.wearLog.findFirst({
      where: { id: req.params.id, garment: { wardrobeId: req.ctx.wardrobeId } },
    });
    if (!log) throw new HttpError('NOT_FOUND', '穿着记录不存在');
    await prisma.$transaction(async (tx) => {
      await tx.wearLog.delete({ where: { id: log.id } });
      const garment = await tx.garment.findUniqueOrThrow({ where: { id: log.garmentId } });
      await tx.garment.update({
        where: { id: garment.id },
        data: { wearsSinceWash: Math.max(0, garment.wearsSinceWash - 1) },
      });
    });
    ok(req, res, { deleted: true });
  }),
);

export async function recordWear(
  wardrobeId: string,
  userId: string,
  body: z.infer<typeof wearLogSchema>,
): Promise<{ duplicate: boolean; wearLog: unknown; garmentId: string }> {
  const garment = await prisma.garment.findFirst({
    where: { id: body.garmentId, wardrobeId, deletedAt: null },
  });
  if (!garment) throw new HttpError('NOT_FOUND', '衣物档案不存在');
  if (garment.status === 'retired') throw new HttpError('GARMENT_RETIRED', '衣物已退役，不再统计穿着');

  const wornOn = parseDateOnly(body.wornOn);

  if (body.clientOpId) {
    const byOp = await prisma.wearLog.findUnique({ where: { clientOpId: body.clientOpId } });
    if (byOp) return { duplicate: true, wearLog: byOp, garmentId: garment.id };
  }

  // 同一天同一件衣服只算一次（数据库唯一约束 + 这里提前返回，保证幂等）
  const existing = await prisma.wearLog.findUnique({
    where: { garmentId_wornOn: { garmentId: garment.id, wornOn } },
  });
  if (existing) return { duplicate: true, wearLog: existing, garmentId: garment.id };

  const season = body.seasonSnapshot ?? seasonOfMonth(wornOn.getUTCMonth() + 1);
  try {
    const wearLog = await prisma.$transaction(async (tx) => {
      const record = await tx.wearLog.create({
        data: {
          garmentId: garment.id,
          wornOn,
          session: body.session,
          seasonSnapshot: season,
          weatherSnapshot: (body.weatherSnapshot ?? undefined) as never,
          occasion: body.occasion ?? null,
          intensity: body.intensity,
          note: body.note ?? null,
          clientOpId: body.clientOpId ?? null,
          createdBy: userId,
        },
      });
      await tx.garment.update({
        where: { id: garment.id },
        data: {
          wearsSinceWash: { increment: 1 },
          ...(garment.firstWearDate && garment.firstWearDate.getTime() <= wornOn.getTime()
            ? {}
            : { firstWearDate: wornOn }),
        },
      });
      return record;
    });
    return { duplicate: false, wearLog, garmentId: garment.id };
  } catch (error) {
    // 两个请求同时打同一天的卡时，唯一约束会拦住后一个：
    // 这在业务上本来就是"幂等"，应该返回已有记录，而不是 500。
    if (isUniqueViolation(error)) {
      const existing = await prisma.wearLog.findUnique({
        where: { garmentId_wornOn: { garmentId: garment.id, wornOn } },
      });
      if (existing) return { duplicate: true, wearLog: existing, garmentId: garment.id };
    }
    throw error;
  }
}
