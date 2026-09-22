import { Router } from 'express';
import { offlineSyncSchema } from '@gml/shared';
import { HttpError } from '../lib/errors.js';
import { handler, ok, parseBody } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { createDamage } from './damage.routes.js';
import { createRepair } from './repair.routes.js';
import { recordWear } from './wear.routes.js';

export const syncRouter = Router();
syncRouter.use(requireAuth);

/**
 * 离线队列批量同步（项目文档 F22）：
 * 断网时各端把破损登记 / 修补登记 / 穿着打点先落本地，联网后整批提交。
 * 逐条处理、逐条回报——一条失败不阻塞后面的记录：
 *   - ok：新建成功
 *   - duplicate：clientOpId 已建过（重试/多端重放），幂等返回
 *   - rejected：业务校验不过（衣物已退役、标记不存在等），再重试也不会成功
 *   - conflict：记录版本落后于服务端（离线期间别的端改过），需用户合并
 */
syncRouter.post(
  '/',
  handler(async (req, res) => {
    const body = parseBody(offlineSyncSchema, req.body);
    const results: Array<{
      opId: string;
      kind: string;
      status: 'ok' | 'duplicate' | 'rejected' | 'conflict';
      entityType?: string;
      entityId?: string;
      code?: string;
      version?: number;
      errorCode?: string;
      message?: string;
      conflict?: unknown;
    }> = [];

    for (const op of body.ops) {
      try {
        if (op.kind === 'wear-log') {
          const result = await recordWear(req.ctx.wardrobeId, req.ctx.userId, {
            ...op.payload,
            clientOpId: op.opId,
          });
          results.push({
            opId: op.opId,
            kind: 'wear-log',
            status: result.duplicate ? 'duplicate' : 'ok',
            entityType: 'wear_log',
            entityId: (result.wearLog as { id: string }).id,
          });
        } else if (op.kind === 'damage-create') {
          const result = await createDamage({
            wardrobeId: req.ctx.wardrobeId,
            userId: req.ctx.userId,
            body: { ...op.payload, clientOpId: op.opId },
            requestId: req.ctx.requestId,
            email: req.ctx.email,
          });
          results.push({
            opId: op.opId,
            kind: 'damage-create',
            status: result.duplicate ? 'duplicate' : 'ok',
            entityType: 'damage_event',
            entityId: result.damage.id,
            code: result.damage.code,
            version: result.damage.version,
          });
        } else {
          const result = await createRepair({
            wardrobeId: req.ctx.wardrobeId,
            userId: req.ctx.userId,
            body: { ...op.payload, clientOpId: op.opId },
            requestId: req.ctx.requestId,
            expectedDamageVersion: op.expectedDamageVersion,
          });
          results.push({
            opId: op.opId,
            kind: 'repair-create',
            status: result.duplicate ? 'duplicate' : 'ok',
            entityType: 'repair',
            entityId: result.repair.id,
            version: result.repair.version,
          });
        }
      } catch (error) {
        if (error instanceof HttpError && error.code === 'VERSION_CONFLICT') {
          const details = (error.details ?? {}) as { entityType?: string; entityId?: string; code?: string };
          results.push({
            opId: op.opId,
            kind: op.kind,
            status: 'conflict',
            message: error.message,
            errorCode: error.code,
            conflict: error.details,
            // 拍平一份，方便客户端直接给"打开最新记录"跳转
            entityType: details.entityType,
            entityId: details.entityId,
            code: details.code,
          });
        } else if (error instanceof HttpError) {
          // 业务错误（衣物已退役、日期非法等）：再重试一万次也不会成功，
          // 标记 rejected 让客户端移出纳队列并提示用户，而不是让队列永远卡住。
          results.push({
            opId: op.opId,
            kind: op.kind,
            status: 'rejected',
            message: error.message,
            errorCode: error.code,
          });
        } else {
          // 没料到的错误（500 类）：不当成业务拒绝，抛出由中间件处理，
          // 整批保留在客户端队列里，下次再试。
          throw error;
        }
      }
    }

    ok(req, res, {
      results,
      synced: results.filter((r) => r.status === 'ok').length,
      duplicates: results.filter((r) => r.status === 'duplicate').length,
      rejected: results.filter((r) => r.status === 'rejected').length,
      conflicts: results.filter((r) => r.status === 'conflict').length,
    });
  }),
);
