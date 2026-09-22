import { Router } from 'express';
import { z } from 'zod';
import {
  DAMAGE_TERMINAL_STATUSES,
  damageCancelSchema,
  damageCreateSchema,
  damageLinkRecurrenceSchema,
  damageScheduleSchema,
  damageUpdateSchema,
  type DamageStatus,
} from '@gml/shared';
import { HttpError } from '../lib/errors.js';
import type { Prisma } from '@prisma/client';
import { created, handler, ok, parseBody, parseQuery } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { logActivity } from '../lib/activity.js';
import { nextDamageCode } from '../lib/ids.js';
import { withUniqueRetry } from '../lib/prisma-errors.js';
import { addDays, parseDateOnly } from '../lib/date.js';
import { requireAuth } from '../middleware/auth.js';
import { syncGarmentStatus } from '../services/stats.js';
import { createReminderIfAbsent, notifyRecurrence } from '../services/rules/engine.js';

export const damageRouter = Router();
damageRouter.use(requireAuth);

damageRouter.get(
  '/',
  handler(async (req, res) => {
    const query = parseQuery(
      z.object({
        garmentId: z.string().optional(),
        status: z.string().optional(),
        partId: z.string().optional(),
        damageTypeId: z.string().optional(),
        open: z.coerce.boolean().optional(),
        recurringOnly: z.coerce.boolean().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );

    const damages = await prisma.damageEvent.findMany({
      where: {
        garment: { wardrobeId: req.ctx.wardrobeId, deletedAt: null },
        ...(query.garmentId ? { garmentId: query.garmentId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.partId ? { partId: query.partId } : {}),
        ...(query.damageTypeId ? { damageTypeId: query.damageTypeId } : {}),
        ...(query.open ? { status: { notIn: DAMAGE_TERMINAL_STATUSES } } : {}),
        ...(query.recurringOnly ? { recurrenceOf: { not: null } } : {}),
      },
      include: {
        garment: { select: { id: true, code: true, name: true, materialPrimary: true } },
        damageType: true,
        part: true,
        repairs: { orderBy: { round: 'asc' }, include: { stitch: true, reviews: true, change: true } },
        annotations: { select: { id: true, photoId: true, geometry: true, kind: true } },
      },
      orderBy: { detectedAt: 'desc' },
      take: query.limit,
    });

    ok(req, res, {
      items: damages.map((d) => ({
        id: d.id,
        code: d.code,
        garment: d.garment,
        damageType: d.damageType,
        part: d.part,
        severity: d.severity,
        status: d.status,
        detectedAt: d.detectedAt,
        scheduledAt: d.scheduledAt,
        isRecurrence: !!d.recurrenceOf,
        recurrenceIndex: d.recurrenceIndex,
        repairCount: d.repairs.length,
        lastRepair: d.repairs.at(-1)
          ? {
              id: d.repairs.at(-1)!.id,
              round: d.repairs.at(-1)!.round,
              stitch: d.repairs.at(-1)!.stitch.name,
              status: d.repairs.at(-1)!.status,
              observationUntil: d.repairs.at(-1)!.observationUntil,
              verdict: d.repairs.at(-1)!.reviews.at(-1)?.verdict ?? null,
            }
          : null,
        annotationCount: d.annotations.length,
      })),
    });
  }),
);

damageRouter.post(
  '/',
  handler(async (req, res) => {
    const body = parseBody(damageCreateSchema, req.body);
    const { damage, annotationCount, duplicate } = await createDamage({
      wardrobeId: req.ctx.wardrobeId,
      userId: req.ctx.userId,
      body,
      requestId: req.ctx.requestId,
      email: req.ctx.email,
    });
    if (duplicate) {
      ok(req, res, { damage, annotationCount, isRecurrence: !!body.recurrenceOfId }, { idempotent: true });
      return;
    }
    created(req, res, { damage, annotationCount, isRecurrence: !!body.recurrenceOfId });
  }),
);

damageRouter.get(
  '/:id',
  handler(async (req, res) => {
    const damage = await findDamageOrThrow(req.params.id, req.ctx.wardrobeId);
    const full = await prisma.damageEvent.findUniqueOrThrow({
      where: { id: damage.id },
      include: {
        garment: true,
        damageType: true,
        part: true,
        repairs: {
          orderBy: { round: 'asc' },
          include: {
            stitch: true,
            change: true,
            materials: { include: { fabricSource: true } },
            reviews: { orderBy: { reviewedAt: 'asc' } },
          },
        },
        annotations: { include: { photo: true, part: true } },
        original: { select: { id: true, code: true, detectedAt: true } },
        recurrences: { select: { id: true, code: true, detectedAt: true, status: true } },
      },
    });
    const suggested = await prisma.stitch.findMany();
    ok(req, res, {
      damage: full,
      suggestedStitches: suggested.filter((s) => {
        const types = Array.isArray(s.suitableDamageTypes) ? (s.suitableDamageTypes as string[]) : [];
        return types.includes(full.damageType.code) || types.length === 0;
      }),
    });
  }),
);

damageRouter.patch(
  '/:id',
  handler(async (req, res) => {
    const damage = await findDamageOrThrow(req.params.id, req.ctx.wardrobeId);
    if (DAMAGE_TERMINAL_STATUSES.includes(damage.status as DamageStatus)) {
      throw new HttpError('DAMAGE_ALREADY_RESOLVED', '这个破损事件已经终结，只能追加备注，不能修改关键信息');
    }
    const body = parseBody(damageUpdateSchema, req.body);
    if (body.expectedVersion !== undefined && body.expectedVersion !== damage.version) {
      throw new HttpError(
        'VERSION_CONFLICT',
        `这条破损在你编辑期间已被其他端修改（你的版本 v${body.expectedVersion}，当前版本 v${damage.version}），请刷新后合并修改`,
        {
          entityType: 'damage_event',
          entityId: damage.id,
          code: damage.code,
          expectedVersion: body.expectedVersion,
          currentVersion: damage.version,
          current: {
            damageTypeId: damage.damageTypeId,
            severity: damage.severity,
            partId: damage.partId,
            detectedAt: damage.detectedAt,
            description: damage.description,
            causeGuess: damage.causeGuess,
            measurableSize: damage.measurableSize,
          },
        },
      );
    }
    const updated = await prisma.damageEvent.update({
      where: { id: damage.id },
      data: {
        version: { increment: 1 },
        ...(body.damageTypeId ? { damageTypeId: body.damageTypeId } : {}),
        ...(body.severity ? { severity: body.severity } : {}),
        ...(body.partId !== undefined ? { partId: body.partId } : {}),
        ...(body.detectedAt ? { detectedAt: parseDateOnly(body.detectedAt) } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.causeGuess !== undefined ? { causeGuess: body.causeGuess } : {}),
        ...(body.measurableSize !== undefined ? { measurableSize: body.measurableSize as never } : {}),
      },
    });
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'damage_event',
      entityId: damage.id,
      action: 'update',
      diff: body,
      requestId: req.ctx.requestId,
    });
    ok(req, res, { damage: updated });
  }),
);

damageRouter.post(
  '/:id/schedule',
  handler(async (req, res) => {
    const damage = await findDamageOrThrow(req.params.id, req.ctx.wardrobeId);
    const body = parseBody(damageScheduleSchema, req.body);
    const scheduledAt = parseDateOnly(body.scheduledAt);
    const updated = await prisma.damageEvent.update({
      where: { id: damage.id },
      data: { version: { increment: 1 }, scheduledAt, status: damage.status === 'pending' ? 'scheduled' : damage.status },
    });
    await createReminderIfAbsent({
      wardrobeId: req.ctx.wardrobeId,
      userId: req.ctx.userId,
      subjectType: 'damage_event',
      subjectId: damage.id,
      title: `今天计划修：${damage.code}`,
      body: '按计划处理这次破损，修完登记针法、用料与修补后变化。',
      reason: '你设置了计划修补日期。',
      actionKind: 'open_repair_rework',
      actionPayload: { damageEventId: damage.id, garmentId: damage.garmentId },
      dueAt: scheduledAt,
      expireAt: addDays(scheduledAt, 30),
      occurrenceKey: `schedule:${damage.id}`,
      notifyNow: scheduledAt.getTime() <= Date.now(),
    });
    ok(req, res, { damage: updated });
  }),
);

damageRouter.post(
  '/:id/mark-unrepairable',
  handler(async (req, res) => {
    const damage = await findDamageOrThrow(req.params.id, req.ctx.wardrobeId);
    const body = parseBody(z.object({ reason: z.string().min(1).max(300) }), req.body);
    const updated = await prisma.damageEvent.update({
      where: { id: damage.id },
      data: {
        version: { increment: 1 },
        status: 'unrepairable',
        resolvedAt: new Date(),
        cancelReason: body.reason,
      },
    });
    await closeRemindersForDamage(damage.id, { unrepairable: true, reason: body.reason });
    const garmentStatus = await syncGarmentStatus(damage.garmentId);
    ok(req, res, { damage: updated, garmentStatus });
  }),
);

damageRouter.post(
  '/:id/cancel',
  handler(async (req, res) => {
    const damage = await findDamageOrThrow(req.params.id, req.ctx.wardrobeId);
    const body = parseBody(damageCancelSchema, req.body);
    const updated = await prisma.damageEvent.update({
      where: { id: damage.id },
      data: {
        version: { increment: 1 },
        status: 'cancelled',
        resolvedAt: new Date(),
        cancelReason: body.reason,
      },
    });
    await closeRemindersForDamage(damage.id, { cancelled: true, reason: body.reason });
    const garmentStatus = await syncGarmentStatus(damage.garmentId);
    ok(req, res, { damage: updated, garmentStatus });
  }),
);

damageRouter.get(
  '/:id/recurrence-candidates',
  handler(async (req, res) => {
    const damage = await findDamageOrThrow(req.params.id, req.ctx.wardrobeId);
    const candidates = await prisma.damageEvent.findMany({
      where: {
        garmentId: damage.garmentId,
        id: { not: damage.id },
        damageTypeId: damage.damageTypeId,
        ...(damage.partId ? { partId: damage.partId } : {}),
        detectedAt: { lt: damage.detectedAt },
      },
      include: { damageType: true, part: true, repairs: { include: { stitch: true, reviews: true } } },
      orderBy: { detectedAt: 'desc' },
      take: 5,
    });
    ok(req, res, {
      candidates: candidates.map((c) => ({
        id: c.id,
        code: c.code,
        detectedAt: c.detectedAt,
        damageType: c.damageType.name,
        part: c.part?.name ?? null,
        repairCount: c.repairs.length,
        lastStitch: c.repairs.at(-1)?.stitch.name ?? null,
        lastVerdict: c.repairs.at(-1)?.reviews.at(-1)?.verdict ?? null,
        daysSince: Math.round((damage.detectedAt.getTime() - c.detectedAt.getTime()) / 86_400_000),
      })),
    });
  }),
);

damageRouter.post(
  '/:id/link-recurrence',
  handler(async (req, res) => {
    const damage = await findDamageOrThrow(req.params.id, req.ctx.wardrobeId);
    const body = parseBody(damageLinkRecurrenceSchema, req.body);
    if (body.recurrenceOfId === damage.id) throw new HttpError('VALIDATION_FAILED', '不能把自己当作原始事件');
    const original = await prisma.damageEvent.findFirst({
      where: { id: body.recurrenceOfId, garmentId: damage.garmentId },
    });
    if (!original) throw new HttpError('NOT_FOUND', '原始破损事件不存在');
    const updated = await prisma.damageEvent.update({
      where: { id: damage.id },
      data: { recurrenceOf: original.id, recurrenceIndex: (original.recurrenceIndex ?? 1) + 1 },
    });
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'damage_event',
      entityId: damage.id,
      action: 'update',
      diff: { recurrenceOf: original.id, recurrenceIndex: updated.recurrenceIndex },
      requestId: req.ctx.requestId,
    });
    // 确认复发的那一刻就发出预警（幂等：同一 damage 只发一次）
    const [garment, part] = await Promise.all([
      prisma.garment.findUniqueOrThrow({ where: { id: damage.garmentId } }),
      damage.partId ? prisma.part.findUnique({ where: { id: damage.partId } }) : Promise.resolve(null),
    ]);
    await notifyRecurrence(
      req.ctx.wardrobeId,
      req.ctx.userId,
      damage.id,
      garment.id,
      garment.name,
      part?.name ?? null,
      req.ctx.email,
    );
    ok(req, res, { damage: updated });
  }),
);

async function findDamageOrThrow(id: string, wardrobeId: string) {
  const damage = await prisma.damageEvent.findFirst({
    where: { id, garment: { wardrobeId, deletedAt: null } },
  });
  if (!damage) throw new HttpError('NOT_FOUND', '破损事件不存在');
  return damage;
}

export interface CreateDamageContext {
  wardrobeId: string;
  userId: string;
  body: z.infer<typeof damageCreateSchema>;
  requestId?: string;
  email?: string;
}

/**
 * 登记破损（在线路由与离线同步端点共用一份逻辑）。
 * 幂等：同一 clientOpId 重放直接返回已建记录（多端并发同步时不会造重复）。
 */
export async function createDamage(ctx: CreateDamageContext): Promise<{
  damage: Prisma.DamageEventGetPayload<Record<string, never>>;
  annotationCount: number;
  duplicate: boolean;
}> {
  const { wardrobeId, userId, body: input } = ctx;
  const garment = await prisma.garment.findFirst({
    where: { id: input.garmentId, wardrobeId, deletedAt: null },
  });
  if (!garment) throw new HttpError('NOT_FOUND', '衣物档案不存在');
  if (garment.status === 'retired') {
    throw new HttpError('GARMENT_RETIRED', '这件衣物已经退役，如需继续记录请先恢复为在用');
  }

  // 离线重放 / 多端重复提交：同 clientOpId 直接返回首建记录
  if (input.clientOpId) {
    const byOp = await prisma.damageEvent.findUnique({ where: { clientOpId: input.clientOpId } });
    if (byOp) return { damage: byOp, annotationCount: Array.isArray(byOp.photosSnapshot) ? (byOp.photosSnapshot as unknown[]).length : 0, duplicate: true };
  }

  // 标记必须属于这件衣物，防止张冠李戴
  const annotations = input.annotationIds.length
    ? await prisma.photoAnnotation.findMany({ where: { id: { in: input.annotationIds } } })
    : [];
  if (annotations.length !== input.annotationIds.length) {
    throw new HttpError('NOT_FOUND', '有标记不存在，请重新在照片上标注');
  }
  const foreign = annotations.filter((a) => a.garmentId !== garment.id);
  if (foreign.length > 0) throw new HttpError('VALIDATION_FAILED', '标记不属于这件衣物');

  const damageType = await prisma.damageType.findUnique({ where: { id: input.damageTypeId } });
  if (!damageType) throw new HttpError('NOT_FOUND', '破损类型不存在');

  let recurrenceIndex: number | null = null;
  if (input.recurrenceOfId) {
    const original = await prisma.damageEvent.findFirst({
      where: { id: input.recurrenceOfId, garmentId: garment.id },
    });
    if (!original) throw new HttpError('NOT_FOUND', '要关联的原始破损事件不存在');
    recurrenceIndex = (original.recurrenceIndex ?? 1) + 1;
  }

  const photoSnapshot = annotations.map((annotation) => ({
    annotationId: annotation.id,
    photoId: annotation.photoId,
    kind: annotation.kind,
    geometry: annotation.geometry,
    partId: annotation.partId,
    label: annotation.label,
  }));

  // 破损编号同样是「查数量 +1」，并发登记会撞车 → 撞了就重算
  const damage = await withUniqueRetry(async () => {
    const code = await nextDamageCode(garment.id, garment.code);
    return prisma.$transaction(async (tx) => {
      const record = await tx.damageEvent.create({
        data: {
          garmentId: garment.id,
          code,
          damageTypeId: input.damageTypeId,
          severity: input.severity,
          partId: input.partId ?? null,
          detectedAt: parseDateOnly(input.detectedAt),
          detectedSource: input.detectedSource,
          description: input.description ?? null,
          causeGuess: input.causeGuess ?? null,
          measurableSize: (input.measurableSize ?? undefined) as never,
          status: input.scheduledAt ? 'scheduled' : 'pending',
          scheduledAt: input.scheduledAt ? parseDateOnly(input.scheduledAt) : null,
          locationUnknown: input.locationUnknown,
          locationNote: input.locationNote ?? null,
          recurrenceOf: input.recurrenceOfId ?? null,
          recurrenceIndex,
          photosSnapshot: photoSnapshot as never,
          clientOpId: input.clientOpId ?? null,
          createdBy: userId,
        },
      });
      // 标记 → 破损事件，并冻结为证据（后续被改动也不影响当时的记录）
      if (annotations.length > 0) {
        await tx.photoAnnotation.updateMany({
          where: { id: { in: annotations.map((a) => a.id) } },
          data: { damageEventId: record.id, status: 'linked', frozen: true },
        });
      }
      return record;
    });
  });

  await syncGarmentStatus(garment.id);

  // 排期提醒：到了计划那天把这件事推回眼前
  if (input.scheduledAt) {
    const dueAt = parseDateOnly(input.scheduledAt);
    await createReminderIfAbsent({
      wardrobeId,
      userId,
      subjectType: 'damage_event',
      subjectId: damage.id,
      title: `今天计划修：${garment.name}`,
      body: `${damage.code}（${damageType.name}）原计划今天处理，修完记得登记针法与用料。`,
      reason: '你在登记破损时设置了计划修补日期。',
      actionKind: 'open_repair_rework',
      actionPayload: { damageEventId: damage.id, garmentId: garment.id },
      dueAt,
      expireAt: addDays(dueAt, 30),
      occurrenceKey: `schedule:${damage.id}`,
      notifyNow: dueAt.getTime() <= Date.now(),
    });
  }

  if (input.recurrenceOfId) {
    const part = input.partId ? await prisma.part.findUnique({ where: { id: input.partId } }) : null;
    await notifyRecurrence(
      wardrobeId,
      userId,
      damage.id,
      garment.id,
      garment.name,
      part?.name ?? null,
      ctx.email ?? '',
    );
  }

  await logActivity({
    wardrobeId,
    actorId: userId,
    entityType: 'damage_event',
    entityId: damage.id,
    action: 'create',
    diff: { code: damage.code, severity: damage.severity, annotationCount: annotations.length, offline: !!input.clientOpId },
    requestId: ctx.requestId,
  });

  return { damage, annotationCount: annotations.length, duplicate: false };
}

async function closeRemindersForDamage(damageId: string, resultRef: Record<string, unknown>) {
  await prisma.reminder.updateMany({
    where: { subjectType: 'damage_event', subjectId: damageId, status: { in: ['pending', 'notified'] } },
    data: { status: 'done', handledAt: new Date(), resultRef: resultRef as never },
  });
}
