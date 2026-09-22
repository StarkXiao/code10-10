import { HttpError } from './errors.js';

/**
 * 版本冲突（409）：客户端按 baseVersion 合并时，服务器上的记录已被别处改过。
 * details 里带上服务器当前记录，前端据此向用户展示「本地修改 vs 服务器最新」，
 * 由用户决定保留哪一边（放弃本地 / 以本地覆盖最新版本）。
 */
export function versionConflict<T extends { version: number }>(current: T): HttpError {
  return new HttpError(
    'VERSION_CONFLICT',
    '这条记录在你编辑期间被其他设备修改过，请对比后决定保留哪一版',
    { currentVersion: current.version, serverRecord: current },
  );
}
