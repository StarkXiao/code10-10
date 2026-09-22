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
import { created, handler, ok, parseBody, parseQuery } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { logActivity } from '../lib/activity.js';
import { nextDamageCode } from '../lib/ids.js';
import { isUniqueViolation, withUniqueRetry } from '../lib/prisma-errors.js';
import { versionConflict } from '../lib/versioned.js';
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

    // 离线队列重放的幂等出口：同一个 clientOpId 无论同步几次，都只对应一条破损事件
    if (body.clientOpId) {
      const replayed = await findDamageByOpId(body.clientOpId, req.ctx.wardrobeId);
      if (replayed) {
        ok(req, res, { damage: replayed, idempotent: true }, { idempotent: true });
        return;
      }
    }

    const garment = await prisma.garment.findFirst({
      where: { id: body.garmentId, wardrobeId: req.ctx.wardrobeId, deletedAt: null },
    });
    if (!garment) throw new HttpError('NOT_FOUND', '衣物档案不存在');
    if (garment.status === 'retired') {
      throw new HttpError('GARMENT_RETIRED', '这件衣物已经退役，如需继续记录请先恢复为在用');
    }

    // 标记必须属于这件衣物，防止张冠李戴
    const annotations = body.annotationIds.length
      ? await prisma.photoAnnotation.findMany({ where: { id: { in: body.annotationIds } } })
      : [];
    if (annotations.length !== body.annotationIds.length) {
      throw new HttpError('NOT_FOUND', '有标记不存在，请重新在照片上标注');
    }
    const foreign = annotations.filter((a) => a.garmentId !== garment.id);
    if (foreign.length > 0) throw new HttpError('VALIDATION_FAILED', '标记不属于这件衣物');

    const damageType = await prisma.damageType.findUnique({ where: { id: body.damageTypeId } });
    if (!damageType) throw new HttpError('NOT_FOUND', '破损类型不存在');

    let recurrenceIndex: number | null = null;
    if (body.recurrenceOfId) {
      const original = await prisma.damageEvent.findFirst({
        where: { id: body.recurrenceOfId, garmentId: garment.id },
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
    let damage;
    try {
      damage = await withUniqueRetry(async () => {
        const code = await nextDamageCode(garment.id, garment.code);
        return prisma.$transaction(async (tx) => {
          const record = await tx.damageEvent.create({
            data: {
              garmentId: garment.id,
              code,
              damageTypeId: body.damageTypeId,
              severity: body.severity,
              partId: body.partId ?? null,
              detectedAt: parseDateOnly(body.detectedAt),
              detectedSource: body.detectedSource,
              description: body.description ?? null,
              causeGuess: body.causeGuess ?? null,
              measurableSize: (body.measurableSize ?? undefined) as never,
              status: body.scheduledAt ? 'scheduled' : 'pending',
              scheduledAt: body.scheduledAt ? parseDateOnly(body.scheduledAt) : null,
              locationUnknown: body.locationUnknown,
              locationNote: body.locationNote ?? null,
              recurrenceOf: body.recurrenceOfId ?? null,
              recurrenceIndex,
              photosSnapshot: photoSnapshot as never,
              clientOpId: body.clientOpId ?? null,
              createdBy: req.ctx.userId,
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
    } catch (error) {
      // 同一条离线记录被并发重放（两个标签页同时恢复网络）：
      // client_op_id 唯一约束拦住重复插入，返回已建好的那条即是幂等成功
      if (body.clientOpId && isUniqueViolation(error)) {
        const replayed = await findDamageByOpId(body.clientOpId, req.ctx.wardrobeId);
        if (replayed) {
          ok(req, res, { damage: replayed, idempotent: true }, { idempotent: true });
          return;
        }
      }
      throw error;
    }

    await syncGarmentStatus(garment.id);

    // 排期提醒：到了计划那天把这件事推回眼前
    if (body.scheduledAt) {
      const dueAt = parseDateOnly(body.scheduledAt);
      await createReminderIfAbsent({
        wardrobeId: req.ctx.wardrobeId,
        userId: req.ctx.userId,
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

    if (body.recurrenceOfId) {
      const part = body.partId ? await prisma.part.findUnique({ where: { id: body.partId } }) : null;
      await notifyRecurrence(
        req.ctx.wardrobeId,
        req.ctx.userId,
        damage.id,
        garment.id,
        garment.name,
        part?.name ?? null,
        req.ctx.email,
      );
    }

    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'damage_event',
      entityId: damage.id,
      action: 'create',
      diff: { code: damage.code, severity: damage.severity, annotationCount: annotations.length },
      requestId: req.ctx.requestId,
    });

    created(req, res, { damage, annotationCount: annotations.length, isRecurrence: !!body.recurrenceOfId });
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
    const fields = {
      ...(body.damageTypeId ? { damageTypeId: body.damageTypeId } : {}),
      ...(body.severity ? { severity: body.severity } : {}),
      ...(body.partId !== undefined ? { partId: body.partId } : {}),
      ...(body.detectedAt ? { detectedAt: parseDateOnly(body.detectedAt) } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.causeGuess !== undefined ? { causeGuess: body.causeGuess } : {}),
      ...(body.measurableSize !== undefined ? { measurableSize: body.measurableSize as never } : {}),
    };
    let updated;
    if (body.baseVersion !== undefined) {
      // 多端合并：只有记录仍停留在客户端编辑时的版本才落库（同时版本 +1）；
      // 否则说明期间被别的端改过，返回 409 与服务器当前记录，让用户决定保留哪一版
      const merged = await prisma.damageEvent.updateMany({
        where: { id: damage.id, version: body.baseVersion },
        // updateMany 不触发 @updatedAt，显式带上
        data: { ...fields, version: { increment: 1 }, updatedAt: new Date() },
      });
      if (merged.count === 0) {
        throw versionConflict(await prisma.damageEvent.findUniqueOrThrow({ where: { id: damage.id } }));
      }
      updated = await prisma.damageEvent.findUniqueOrThrow({ where: { id: damage.id } });
    } else {
      updated = await prisma.damageEvent.update({
        where: { id: damage.id },
        data: { ...fields, version: { increment: 1 } },
      });
    }
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
      data: { scheduledAt, status: damage.status === 'pending' ? 'scheduled' : damage.status, version: { increment: 1 } },
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
      data: { status: 'unrepairable', resolvedAt: new Date(), cancelReason: body.reason, version: { increment: 1 } },
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
      data: { status: 'cancelled', resolvedAt: new Date(), cancelReason: body.reason, version: { increment: 1 } },
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
      data: { recurrenceOf: original.id, recurrenceIndex: (original.recurrenceIndex ?? 1) + 1, version: { increment: 1 } },
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

/** 按离线幂等键找记录（限定在当前衣橱内，避免跨衣橱串号） */
async function findDamageByOpId(clientOpId: string, wardrobeId: string) {
  return prisma.damageEvent.findFirst({
    where: { clientOpId, garment: { wardrobeId, deletedAt: null } },
  });
}

async function closeRemindersForDamage(damageId: string, resultRef: Record<string, unknown>) {
  await prisma.reminder.updateMany({
    where: { subjectType: 'damage_event', subjectId: damageId, status: { in: ['pending', 'notified'] } },
    data: { status: 'done', handledAt: new Date(), resultRef: resultRef as never },
  });
}
