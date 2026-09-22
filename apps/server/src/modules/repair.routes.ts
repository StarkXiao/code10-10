import { Router } from 'express';
import { z } from 'zod';
import {
  DAMAGE_TERMINAL_STATUSES,
  daysBetween,
  num,
  repairChangeSchema,
  repairCreateSchema,
  repairMaterialSchema,
  repairUpdateSchema,
  reviewSchema,
  startObservationSchema,
  type DamageStatus,
} from '@gml/shared';
import { HttpError } from '../lib/errors.js';
import type { Prisma } from '@prisma/client';
import { created, handler, ok, parseBody, parseQuery } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { logActivity } from '../lib/activity.js';
import { addDays, parseDateOnly } from '../lib/date.js';
import { requireAuth } from '../middleware/auth.js';
import { syncGarmentStatus } from '../services/stats.js';
import { createReminderIfAbsent } from '../services/rules/engine.js';
import { performReview } from '../services/review.js';
import { withUniqueRetry } from '../lib/prisma-errors.js';

export const repairRouter = Router();
repairRouter.use(requireAuth);

repairRouter.get(
  '/',
  handler(async (req, res) => {
    const query = parseQuery(
      z.object({
        garmentId: z.string().optional(),
        damageEventId: z.string().optional(),
        status: z.string().optional(),
        stitchId: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    const repairs = await prisma.repair.findMany({
      where: {
        damageEvent: {
          garment: { wardrobeId: req.ctx.wardrobeId, deletedAt: null },
          ...(query.garmentId ? { garmentId: query.garmentId } : {}),
          ...(query.damageEventId ? { id: query.damageEventId } : {}),
        },
        ...(query.status ? { status: query.status } : {}),
        ...(query.stitchId ? { stitchId: query.stitchId } : {}),
        ...(query.from || query.to
          ? {
              finishedAt: {
                ...(query.from ? { gte: parseDateOnly(query.from) } : {}),
                ...(query.to ? { lte: parseDateOnly(query.to) } : {}),
              },
            }
          : {}),
      },
      include: {
        damageEvent: { include: { garment: { select: { id: true, code: true, name: true } }, damageType: true, part: true } },
        stitch: true,
        change: true,
        reviews: { orderBy: { reviewedAt: 'desc' }, take: 1 },
        materials: { include: { fabricSource: { select: { id: true, name: true } } } },
      },
      orderBy: { finishedAt: 'desc' },
      take: query.limit,
    });
    ok(req, res, {
      items: repairs.map((r) => ({
        id: r.id,
        round: r.round,
        garment: r.damageEvent.garment,
        damageCode: r.damageEvent.code,
        damageType: r.damageEvent.damageType.name,
        part: r.damageEvent.part?.name ?? null,
        stitch: r.stitch.name,
        executedBy: r.executedBy,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        observationUntil: r.observationUntil,
        status: r.status,
        cost: r.cost?.toString() ?? r.shopCost?.toString() ?? null,
        hasChange: !!r.change,
        latestVerdict: r.reviews[0]?.verdict ?? null,
        materialCount: r.materials.length,
      })),
    });
  }),
);

repairRouter.post(
  '/',
  handler(async (req, res) => {
    const body = parseBody(repairCreateSchema, req.body);
    const { repair, duplicate } = await createRepair({
      wardrobeId: req.ctx.wardrobeId,
      userId: req.ctx.userId,
      body,
      requestId: req.ctx.requestId,
    });
    if (duplicate) {
      ok(req, res, { repair, duplicate, nextStep: '已存在相同的离线操作，本次为幂等返回' }, { idempotent: true });
      return;
    }
    created(req, res, {
      repair,
      duplicate,
      nextStep: '请补全「修补后变化」并上传前后对比照片，然后开始观察期。',
    });
  }),
);

repairRouter.get(
  '/:id',
  handler(async (req, res) => {
    const repair = await findRepairOrThrow(req.params.id, req.ctx.wardrobeId);
    const full = await prisma.repair.findUniqueOrThrow({
      where: { id: repair.id },
      include: {
        damageEvent: { include: { garment: true, damageType: true, part: true } },
        stitch: true,
        change: true,
        materials: { include: { fabricSource: { include: { inventory: true } } } },
        reviews: { orderBy: { reviewedAt: 'asc' } },
        txns: { orderBy: { createdAt: 'desc' } },
        annotations: { include: { photo: true } },
      },
    });
    const secondaryIds = Array.isArray(full.stitchSecondaryIds) ? (full.stitchSecondaryIds as string[]) : [];
    const secondaryStitches = secondaryIds.length
      ? await prisma.stitch.findMany({ where: { id: { in: secondaryIds } } })
      : [];
    ok(req, res, {
      repair: full,
      secondaryStitches,
      daysUntilObservationEnd: daysBetween(new Date(), full.observationUntil),
      totalCost:
        Math.round((num(full.cost?.toString()) + num(full.shopCost?.toString())) * 100) / 100,
    });
  }),
);

repairRouter.patch(
  '/:id',
  handler(async (req, res) => {
    const repair = await findRepairOrThrow(req.params.id, req.ctx.wardrobeId);
    if (repair.status === 'passed' || repair.status === 'superseded') {
      throw new HttpError('CONFLICT', '已闭环的修补记录不能再修改，如需更正请追加备注');
    }
    const body = parseBody(repairUpdateSchema, req.body);
    if (body.expectedVersion !== undefined && body.expectedVersion !== repair.version) {
      throw new HttpError(
        'VERSION_CONFLICT',
        `这条修补在你编辑期间已被其他端修改（你的版本 v${body.expectedVersion}，当前版本 v${repair.version}），请刷新后合并修改`,
        {
          entityType: 'repair',
          entityId: repair.id,
          expectedVersion: body.expectedVersion,
          currentVersion: repair.version,
          current: {
            stitchId: repair.stitchId,
            threadType: repair.threadType,
            threadColor: repair.threadColor,
            durationMinutes: repair.durationMinutes,
            cost: repair.cost,
            resultRating: repair.resultRating,
            note: repair.note,
            observationDays: repair.observationDays,
          },
        },
      );
    }
    const observationDays = body.observationDays ?? repair.observationDays;
    const updated = await prisma.repair.update({
      where: { id: repair.id },
      data: {
        version: { increment: 1 },
        ...(body.stitchId ? { stitchId: body.stitchId } : {}),
        ...(body.stitchSecondaryIds ? { stitchSecondaryIds: body.stitchSecondaryIds as never } : {}),
        ...(body.threadType !== undefined ? { threadType: body.threadType } : {}),
        ...(body.threadColor !== undefined ? { threadColor: body.threadColor } : {}),
        ...(body.durationMinutes !== undefined ? { durationMinutes: body.durationMinutes } : {}),
        ...(body.cost !== undefined ? { cost: body.cost } : {}),
        ...(body.resultRating !== undefined ? { resultRating: body.resultRating } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
        ...(body.observationDays !== undefined
          ? { observationDays, observationUntil: addDays(repair.finishedAt, observationDays) }
          : {}),
      },
    });
    ok(req, res, { repair: updated });
  }),
);

repairRouter.post(
  '/:id/materials',
  handler(async (req, res) => {
    const repair = await findRepairOrThrow(req.params.id, req.ctx.wardrobeId);
    const body = parseBody(repairMaterialSchema, req.body);
    const fabricSource = await prisma.fabricSource.findFirst({
      where: { id: body.fabricSourceId, wardrobeId: req.ctx.wardrobeId },
      include: { inventory: true },
    });
    if (!fabricSource) throw new HttpError('NOT_FOUND', '布料来源不存在');
    if (!fabricSource.inventory) {
      throw new HttpError('VALIDATION_FAILED', '这条布料来源没有登记库存，请先在布料库存里补上数量');
    }

    const result = await prisma.$transaction(async (tx) => {
      const inventory = await tx.fabricInventory.findUniqueOrThrow({ where: { id: fabricSource.inventory!.id } });
      if (inventory.remainingAmount < body.amount) {
        throw new HttpError(
          'INVENTORY_INSUFFICIENT',
          `余料不足：仅剩 ${inventory.remainingAmount}${unitLabel(inventory.unit)}，本次需要 ${body.amount}${unitLabel(inventory.unit)}`,
        );
      }
      const material = await tx.repairMaterial.create({
        data: {
          repairId: repair.id,
          fabricSourceId: fabricSource.id,
          amount: body.amount,
          unit: inventory.unit,
          note: body.note ?? null,
        },
      });
      const updatedInventory = await tx.fabricInventory.update({
        where: { id: inventory.id },
        data: { remainingAmount: { decrement: body.amount } },
      });
      await tx.inventoryTxn.create({
        data: {
          inventoryId: inventory.id,
          repairId: repair.id,
          direction: 'consume',
          amount: body.amount,
          reason: `用于修补 ${repair.id} 第 ${repair.round} 轮`,
          createdBy: req.ctx.userId,
        },
      });
      return { material, inventory: updatedInventory };
    });

    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'repair_material',
      entityId: result.material.id,
      action: 'create',
      diff: { fabricSourceId: fabricSource.id, amount: body.amount },
      requestId: req.ctx.requestId,
    });
    created(req, res, result);
  }),
);

repairRouter.delete(
  '/:id/materials/:materialId',
  handler(async (req, res) => {
    const repair = await findRepairOrThrow(req.params.id, req.ctx.wardrobeId);
    const material = await prisma.repairMaterial.findFirst({
      where: { id: req.params.materialId, repairId: repair.id },
      include: { fabricSource: { include: { inventory: true } } },
    });
    if (!material) throw new HttpError('NOT_FOUND', '这条用料记录不存在');

    await prisma.$transaction(async (tx) => {
      await tx.repairMaterial.delete({ where: { id: material.id } });
      if (material.fabricSource.inventory) {
        await tx.fabricInventory.update({
          where: { id: material.fabricSource.inventory.id },
          data: { remainingAmount: { increment: material.amount } },
        });
        await tx.inventoryTxn.create({
          data: {
            inventoryId: material.fabricSource.inventory.id,
            repairId: repair.id,
            direction: 'adjust',
            amount: material.amount,
            reason: `移除用料记录的回滚（原用料 ${material.id}）`,
            createdBy: req.ctx.userId,
          },
        });
      }
    });
    ok(req, res, { removed: true, rolledBack: true });
  }),
);

repairRouter.put(
  '/:id/change',
  handler(async (req, res) => {
    const repair = await findRepairOrThrow(req.params.id, req.ctx.wardrobeId);
    const body = parseBody(repairChangeSchema, req.body);
    const change = await prisma.repairChange.upsert({
      where: { repairId: repair.id },
      create: {
        repairId: repair.id,
        visibility: body.visibility,
        colorMatch: body.colorMatch,
        dimensionChange: (body.dimensionChange ?? undefined) as never,
        stiffness: body.stiffness,
        drapeChange: body.drapeChange,
        comfortNote: body.comfortNote ?? null,
        mobilityLimited: body.mobilityLimited,
        visibleFromOutside: body.visibleFromOutside,
        photoBeforeId: body.photoBeforeId ?? null,
        photoAfterId: body.photoAfterId ?? null,
        wearTestNote: body.wearTestNote ?? null,
      },
      update: {
        visibility: body.visibility,
        colorMatch: body.colorMatch,
        dimensionChange: (body.dimensionChange ?? undefined) as never,
        stiffness: body.stiffness,
        drapeChange: body.drapeChange,
        comfortNote: body.comfortNote ?? null,
        mobilityLimited: body.mobilityLimited,
        visibleFromOutside: body.visibleFromOutside,
        photoBeforeId: body.photoBeforeId ?? null,
        photoAfterId: body.photoAfterId ?? null,
        wearTestNote: body.wearTestNote ?? null,
      },
    });
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'repair_change',
      entityId: change.id,
      action: 'update',
      diff: body,
      requestId: req.ctx.requestId,
    });
    ok(req, res, { change });
  }),
);

repairRouter.post(
  '/:id/start-observation',
  handler(async (req, res) => {
    const repair = await findRepairOrThrow(req.params.id, req.ctx.wardrobeId);
    const body = parseBody(startObservationSchema, req.body ?? {});
    if (repair.status === 'passed' || repair.status === 'superseded') {
      throw new HttpError('CONFLICT', '这条修补已经闭环');
    }
    const change = await prisma.repairChange.findUnique({ where: { repairId: repair.id } });
    if (!change) {
      throw new HttpError('REPAIR_CHANGE_REQUIRED', '请先填写「修补后变化」，再进入观察期');
    }

    const damage = await prisma.damageEvent.findUniqueOrThrow({
      where: { id: repair.damageEventId },
      include: { garment: true, part: true, damageType: true },
    });

    const observationDays = body.observationDays ?? repair.observationDays;
    const observationUntil = addDays(repair.finishedAt, observationDays);
    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.repair.update({
        where: { id: repair.id },
        data: { version: { increment: 1 }, status: 'observing', observationDays, observationUntil },
      });
      await tx.damageEvent.update({
        where: { id: repair.damageEventId },
        data: { version: { increment: 1 }, status: 'observing' },
      });
      return record;
    });
    await syncGarmentStatus(damage.garmentId);

    const created2 = await createReminderIfAbsent({
      wardrobeId: req.ctx.wardrobeId,
      userId: req.ctx.userId,
      subjectType: 'repair',
      subjectId: repair.id,
      title: `复检：${damage.garment.name}${damage.part ? ` 的 ${damage.part.name}` : ''}`,
      body: `第 ${repair.round} 轮修补（${damage.damageType.name}）进入 ${observationDays} 天观察期，到 ${observationUntil.toISOString().slice(0, 10)} 请检查修补处。`,
      reason: `修补进入观察期，按${repair.executedBy === 'self' || repair.executedBy === 'family' ? '自补' : '送修'}默认 ${observationDays} 天安排复检。`,
      actionKind: 'open_review_form',
      actionPayload: { repairId: repair.id, garmentId: damage.garmentId },
      dueAt: observationUntil,
      expireAt: addDays(observationUntil, 30),
      occurrenceKey: `followup:repair:${repair.id}`,
      priority: 'high',
      notifyNow: observationUntil.getTime() <= Date.now(),
      email: req.ctx.email,
    });

    await syncGarmentStatus(damage.garmentId);
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'repair',
      entityId: repair.id,
      action: 'status_change',
      diff: { to: 'observing', observationDays, observationUntil },
      requestId: req.ctx.requestId,
    });
    ok(req, res, {
      repair: updated,
      observationUntil,
      reminderId: created2.reminderId ?? null,
      reminderCreated: created2.created,
    });
  }),
);

repairRouter.post(
  '/:id/review',
  handler(async (req, res) => {
    const repair = await findRepairOrThrow(req.params.id, req.ctx.wardrobeId);
    const body = parseBody(reviewSchema, req.body);
    const outcome = await performReview({
      repairId: repair.id,
      wardrobeId: req.ctx.wardrobeId,
      userId: req.ctx.userId,
      email: req.ctx.email,
      requestId: req.ctx.requestId,
      input: body,
    });
    created(req, res, outcome);
  }),
);

repairRouter.get(
  '/:id/comparison',
  handler(async (req, res) => {
    const repair = await findRepairOrThrow(req.params.id, req.ctx.wardrobeId);
    const full = await prisma.repair.findUniqueOrThrow({
      where: { id: repair.id },
      include: {
        damageEvent: { include: { garment: true, damageType: true, part: true } },
        stitch: true,
        change: true,
        reviews: { orderBy: { reviewedAt: 'asc' } },
        annotations: { include: { photo: true, part: true } },
      },
    });
    const [before, after] = await Promise.all([
      full.change?.photoBeforeId
        ? prisma.garmentPhoto.findUnique({ where: { id: full.change.photoBeforeId } })
        : prisma.garmentPhoto.findFirst({
            where: { garmentId: full.damageEvent.garmentId, view: 'before', deletedAt: null },
            orderBy: { createdAt: 'desc' },
          }),
      full.change?.photoAfterId
        ? prisma.garmentPhoto.findUnique({ where: { id: full.change.photoAfterId } })
        : prisma.garmentPhoto.findFirst({
            where: { garmentId: full.damageEvent.garmentId, view: 'after', deletedAt: null },
            orderBy: { createdAt: 'desc' },
          }),
    ]);

    const aspectMismatch =
      before && after
        ? Math.abs(before.width / before.height - after.width / after.height) /
            Math.max(before.width / before.height, 0.0001) >
          0.1
        : false;

    ok(req, res, {
      before,
      after,
      aspectMismatch,
      hint: aspectMismatch
        ? '两张照片的宽高比差异较大，拍摄角度可能不同，对比时请注意。'
        : null,
      change: full.change,
      repair: {
        id: full.id,
        round: full.round,
        stitch: full.stitch.name,
        finishedAt: full.finishedAt,
        observationUntil: full.observationUntil,
        status: full.status,
      },
      damage: {
        id: full.damageEvent.id,
        code: full.damageEvent.code,
        damageType: full.damageEvent.damageType.name,
        part: full.damageEvent.part?.name ?? null,
        severity: full.damageEvent.severity,
        description: full.damageEvent.description,
      },
      annotations: full.annotations,
      reviews: full.reviews,
    });
  }),
);

repairRouter.post(
  '/:id/worksheet',
  handler(async (req, res) => {
    const repair = await findRepairOrThrow(req.params.id, req.ctx.wardrobeId);
    const url = `/api/print/repair-worksheet/${repair.damageEventId}`;
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'damage_event',
      entityId: repair.damageEventId,
      action: 'export',
      diff: { kind: 'repair_worksheet', repairId: repair.id },
      requestId: req.ctx.requestId,
    });
    ok(req, res, { url: `${url}?token=${encodeURIComponent(extractToken(req))}` });
  }),
);

export interface CreateRepairContext {
  wardrobeId: string;
  userId: string;
  body: z.infer<typeof repairCreateSchema>;
  requestId?: string;
  /** 离线同步时携带：本地提交时看到的破损版本，落后则报版本冲突 */
  expectedDamageVersion?: number;
}

/**
 * 登记修补（在线路由与离线同步端点共用一份逻辑）。
 * 幂等：同一 clientOpId 重放直接返回已建记录。
 */
export async function createRepair(ctx: CreateRepairContext): Promise<{
  repair: Prisma.RepairGetPayload<Record<string, never>>;
  duplicate: boolean;
}> {
  const { wardrobeId, userId, body } = ctx;
  const damage = await prisma.damageEvent.findFirst({
    where: { id: body.damageEventId, garment: { wardrobeId, deletedAt: null } },
    include: { garment: true, damageType: true },
  });
  if (!damage) throw new HttpError('NOT_FOUND', '破损事件不存在');
  if (DAMAGE_TERMINAL_STATUSES.includes(damage.status as DamageStatus)) {
    throw new HttpError('DAMAGE_ALREADY_RESOLVED', '这个破损事件已经终结，请先重新打开或新建一条破损记录');
  }
  if (damage.garment.status === 'retired') throw new HttpError('GARMENT_RETIRED', '衣物已退役，无法登记修补');
  // 离线期间这条破损在别的端被改过：不能静默覆盖，交给用户合并后再提交
  if (ctx.expectedDamageVersion !== undefined && ctx.expectedDamageVersion !== damage.version) {
    throw new HttpError(
      'VERSION_CONFLICT',
      `你离线期间这条破损已被其他端更新（你的版本 v${ctx.expectedDamageVersion}，当前版本 v${damage.version}），请查看最新记录后再提交修补`,
      {
        entityType: 'damage_event',
        entityId: damage.id,
        code: damage.code,
        expectedVersion: ctx.expectedDamageVersion,
        currentVersion: damage.version,
      },
    );
  }

  // 离线重放 / 多端重复提交：同 clientOpId 直接返回首建记录
  if (body.clientOpId) {
    const byOp = await prisma.repair.findUnique({ where: { clientOpId: body.clientOpId } });
    if (byOp) return { repair: byOp, duplicate: true };
  }

  const stitch = await prisma.stitch.findUnique({ where: { id: body.stitchId } });
  if (!stitch) throw new HttpError('NOT_FOUND', '针法不存在');

  const careRule = await prisma.careRule.findUnique({ where: { materialCode: damage.garment.materialPrimary } });
  const isSelf = body.executedBy === 'self' || body.executedBy === 'family';
  const defaultDays = isSelf
    ? careRule?.observationDaysSelf ?? 14
    : careRule?.observationDaysShop ?? 7;
  const observationDays = body.observationDays ?? defaultDays;
  const finishedAt = parseDateOnly(body.finishedAt);
  const observationUntil = addDays(finishedAt, observationDays);

  // 轮次是「查最大轮次 +1」：并发返工会撞车（damageEventId + round 唯一），撞了就重算
  const repair = await withUniqueRetry(async () => {
    const existing = await prisma.repair.findMany({
      where: { damageEventId: damage.id },
      orderBy: { round: 'desc' },
      take: 1,
    });
    const round = (existing[0]?.round ?? 0) + 1;
    return prisma.$transaction(async (tx) => {
      const record = await tx.repair.create({
        data: {
          damageEventId: damage.id,
          round,
          executedBy: body.executedBy,
          shopName: body.shopName ?? null,
          shopCost: body.shopCost ?? null,
          stitchId: body.stitchId,
          stitchSecondaryIds: (body.stitchSecondaryIds ?? []) as never,
          threadType: body.threadType ?? null,
          threadColor: body.threadColor ?? null,
          durationMinutes: body.durationMinutes ?? null,
          cost: body.cost ?? null,
          startedAt: parseDateOnly(body.startedAt),
          finishedAt,
          resultRating: body.resultRating ?? null,
          observationDays,
          observationUntil,
          status: 'done',
          reuseOriginalFabric: body.reuseOriginalFabric,
          note: body.note ?? null,
          clientOpId: body.clientOpId ?? null,
          createdBy: userId,
        },
      });
      await tx.damageEvent.update({
        where: { id: damage.id },
        data: { version: { increment: 1 }, status: 'repaired' },
      });
      // 上一轮的待办（返工提醒等）到此闭环
      await tx.reminder.updateMany({
        where: { subjectType: 'damage_event', subjectId: damage.id, status: { in: ['pending', 'notified'] } },
        data: {
          status: 'done',
          handledAt: new Date(),
          resultRef: { newRepairId: record.id, round } as never,
        },
      });
      return record;
    });
  });

  await syncGarmentStatus(damage.garmentId);
  await logActivity({
    wardrobeId,
    actorId: userId,
    entityType: 'repair',
    entityId: repair.id,
    action: 'create',
    diff: { damageEventId: damage.id, round: repair.round, stitch: stitch.name, observationDays, offline: !!body.clientOpId },
    requestId: ctx.requestId,
  });

  return { repair, duplicate: false };
}

async function findRepairOrThrow(id: string, wardrobeId: string) {
  const repair = await prisma.repair.findFirst({
    where: { id, damageEvent: { garment: { wardrobeId, deletedAt: null } } },
  });
  if (!repair) throw new HttpError('NOT_FOUND', '修补记录不存在');
  return repair;
}

function unitLabel(unit: string): string {
  return unit === 'cm2' ? 'cm²' : unit === 'cm' ? 'cm' : '片';
}

function extractToken(req: { header: (name: string) => string | undefined }): string {
  const header = req.header('authorization') ?? '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
}
