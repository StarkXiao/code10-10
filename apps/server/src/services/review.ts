/**
 * 复检：整个闭环的收敛点（项目文档 6.1）。
 *
 * 只有两个出口：复检通过（close）或转退役（retire）；
 * failed 不是终点 —— 要么返工回到排期，要么直接进入退役评估。
 * 这里同时被 /repairs/:id/review 和提醒的"一键执行"复用。
 */
import { daysBetween, type ReviewInput } from '@gml/shared';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/errors.js';
import { logActivity } from '../lib/activity.js';
import { addDays } from '../lib/date.js';
import { syncGarmentStatus } from './stats.js';
import { closeRemindersFor, createReminderIfAbsent } from './rules/engine.js';

export interface ReviewOutcome {
  reviewId: string;
  verdict: ReviewInput['verdict'];
  nextAction: ReviewInput['nextAction'];
  repairStatus: string;
  damageStatus: string;
  garmentStatus: string;
  wearCountSince: number;
  reminderCreated: { kind: string; id: string } | null;
}

export async function performReview(params: {
  repairId: string;
  wardrobeId: string;
  userId: string;
  email?: string;
  requestId: string;
  input: ReviewInput;
  sourceReminderId?: string | null;
}): Promise<ReviewOutcome> {
  const repair = await prisma.repair.findFirst({
    where: { id: params.repairId, damageEvent: { garment: { wardrobeId: params.wardrobeId } } },
    include: {
      damageEvent: { include: { garment: true, part: true, damageType: true } },
      reviews: true,
      stitch: true,
    },
  });
  if (!repair) throw new HttpError('NOT_FOUND', '修补记录不存在');
  if (repair.status === 'superseded') {
    throw new HttpError('CONFLICT', '这条修补已被返工替代，请对最新的那一轮做复检');
  }

  const reviewedAt = new Date(params.input.reviewedAt);
  const daysSinceRepair = daysBetween(repair.finishedAt, reviewedAt);

  // 观察期还没到就复检：可能确实，也可能只是点错了。
  // 按文档要求给一个明确的 409，让客户端确认后再提交（避免把"刚补完"当成"已经验过"）。
  if (!params.input.confirmEarly && reviewedAt.getTime() < repair.observationUntil.getTime()) {
    throw new HttpError(
      'OBSERVATION_NOT_FINISHED',
      `这次修补的观察期到 ${repair.observationUntil.toISOString().slice(0, 10)} 才结束，现在复检属于提前复检`,
      { observationUntil: repair.observationUntil, daysUntilEnd: daysBetween(reviewedAt, repair.observationUntil) },
    );
  }

  const wearCountSince =
    params.input.wornSince ??
    (await prisma.wearLog.count({
      where: {
        garmentId: repair.damageEvent.garmentId,
        wornOn: { gte: repair.finishedAt, lte: reviewedAt },
      },
    }));

  const review = await prisma.reviewResult.create({
    data: {
      repairId: repair.id,
      reviewedAt,
      verdict: params.input.verdict,
      wornSince: wearCountSince,
      daysSinceRepair,
      reoccurred: params.input.reoccurred,
      verdictNote: params.input.verdictNote ?? null,
      nextAction: params.input.nextAction,
      sourceReminderId: params.sourceReminderId ?? null,
      createdBy: params.userId,
    },
  });

  let repairStatus = repair.status;
  let damageStatus = repair.damageEvent.status;
  let reminderCreated: ReviewOutcome['reminderCreated'] = null;
  const reviewIndex = repair.reviews.length + 1;

  if (params.input.nextAction === 'close') {
    repairStatus = params.input.verdict === 'failed' ? 'failed' : 'passed';
    damageStatus = 'resolved';
    await prisma.damageEvent.update({
      where: { id: repair.damageEventId },
      data: { version: { increment: 1 }, status: 'resolved', resolvedAt: new Date() },
    });
  } else if (params.input.nextAction === 'monitor') {
    repairStatus = 'observing';
    damageStatus = 'observing';
    await prisma.damageEvent.update({
      where: { id: repair.damageEventId },
      data: { version: { increment: 1 }, status: 'observing' },
    });
    const dueAt = addDays(reviewedAt, 30);
    const created = await createReminderIfAbsent({
      wardrobeId: params.wardrobeId,
      userId: params.userId,
      subjectType: 'repair',
      subjectId: repair.id,
      title: `再观察一次：${repair.damageEvent.garment.name}${repair.damageEvent.part ? ` 的 ${repair.damageEvent.part.name}` : ''}`,
      body: `上次复检结论是"尚可/还需观察"，30 天后请再看一眼修补处。`,
      reason: '你在复检时选择了「继续观察」，系统按 30 天后再检查一次来安排。',
      actionKind: 'open_review_form',
      actionPayload: { repairId: repair.id, garmentId: repair.damageEvent.garmentId },
      dueAt,
      expireAt: addDays(dueAt, 30),
      occurrenceKey: `monitor:repair:${repair.id}:${reviewIndex}`,
      notifyNow: false,
      email: params.email,
    });
    if (created.created && created.reminderId) reminderCreated = { kind: 'monitor', id: created.reminderId };
  } else if (params.input.nextAction === 'rework') {
    repairStatus = 'failed';
    damageStatus = 'pending';
    await prisma.damageEvent.update({
      where: { id: repair.damageEventId },
      data: { version: { increment: 1 }, status: 'pending', resolvedAt: null },
    });
    const dueAt = new Date(reviewedAt);
    const created = await createReminderIfAbsent({
      wardrobeId: params.wardrobeId,
      userId: params.userId,
      subjectType: 'damage_event',
      subjectId: repair.damageEventId,
      title: `安排返工：${repair.damageEvent.garment.name}（${repair.damageEvent.code}）`,
      body: `复检不合格（第 ${repair.round} 轮 · ${repair.stitch.name}）。建议换一种针法或加内侧加固，重新登记一条修补记录。`,
      reason: '你在复检时选择了「返工重修」，系统生成了这条返工任务。',
      actionKind: 'open_repair_rework',
      actionPayload: { damageEventId: repair.damageEventId, garmentId: repair.damageEvent.garmentId },
      dueAt,
      expireAt: addDays(dueAt, 60),
      occurrenceKey: `rework:${repair.damageEventId}:${reviewIndex}`,
      priority: 'high',
      notifyNow: true,
      email: params.email,
    });
    if (created.created && created.reminderId) reminderCreated = { kind: 'rework', id: created.reminderId };
  } else if (params.input.nextAction === 'retire') {
    repairStatus = 'failed';
    damageStatus = 'unrepairable';
    await prisma.damageEvent.update({
      where: { id: repair.damageEventId },
      data: { version: { increment: 1 }, status: 'unrepairable', resolvedAt: new Date() },
    });
    const dueAt = new Date(reviewedAt);
    const created = await createReminderIfAbsent({
      wardrobeId: params.wardrobeId,
      userId: params.userId,
      subjectType: 'garment',
      subjectId: repair.damageEvent.garmentId,
      title: `评估退役：${repair.damageEvent.garment.name}`,
      body: '这件衣物判定为不易修补，看看健康分与每穿成本，决定是改抹布、捐赠、改制还是回收，然后在档案里登记处置方式。',
      reason: '你在复检时选择了「评估退役」。',
      actionKind: 'open_report',
      actionPayload: { garmentId: repair.damageEvent.garmentId },
      dueAt,
      expireAt: addDays(dueAt, 90),
      occurrenceKey: `retire:${repair.damageEvent.garmentId}:${repair.damageEventId}`,
      priority: 'normal',
      notifyNow: true,
      email: params.email,
    });
    if (created.created && created.reminderId) reminderCreated = { kind: 'retire', id: created.reminderId };
  }

  await prisma.repair.update({ where: { id: repair.id }, data: { version: { increment: 1 }, status: repairStatus } });

  // 复检提交后，这条修补相关的待办全部闭环（带结果引用，不能"假完成"）
  await closeRemindersFor('repair', repair.id, { reviewId: review.id, verdict: params.input.verdict });
  if (reminderCreated) {
    await prisma.reminder.update({
      where: { id: reminderCreated.id },
      data: { resultRef: { createdFromReviewId: review.id } },
    });
  }

  const garmentStatus = await syncGarmentStatus(repair.damageEvent.garmentId);

  await logActivity({
    wardrobeId: params.wardrobeId,
    actorId: params.userId,
    entityType: 'review_result',
    entityId: review.id,
    action: 'create',
    diff: {
      repairId: repair.id,
      verdict: params.input.verdict,
      nextAction: params.input.nextAction,
      repairStatus,
      damageStatus,
    },
    requestId: params.requestId,
  });

  return {
    reviewId: review.id,
    verdict: params.input.verdict,
    nextAction: params.input.nextAction,
    repairStatus,
    damageStatus,
    garmentStatus,
    wearCountSince,
    reminderCreated,
  };
}
