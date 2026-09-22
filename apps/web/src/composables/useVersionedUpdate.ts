import { ElMessage, ElNotification } from 'element-plus';
import { damageApi, repairApi } from '../api';
import { ApiError, messageOf } from '../api/client';
import { useOfflineQueueStore, type OfflineOpKind } from '../stores/offlineQueue';

export type VersionedUpdateKind = Extract<OfflineOpKind, 'damage-update' | 'repair-update'>;
export type SaveOutcome = 'saved' | 'queued' | 'conflict' | 'failed';

/**
 * 带版本号的记录保存（多端并发时按记录版本合并）：
 * 在线 → 直接 PATCH（带 baseVersion 乐观锁）；
 * 断网 → 进离线队列，联网后由 useOfflineSync 重放；
 * 版本冲突 → 转「同步冲突」面板等用户拍板，绝不静默覆盖或丢弃。
 */
export function useVersionedUpdate() {
  const offline = useOfflineQueueStore();

  async function save(
    kind: VersionedUpdateKind,
    recordId: string,
    changes: Record<string, unknown>,
    baseVersion: number,
    label: string,
  ): Promise<SaveOutcome> {
    try {
      if (kind === 'damage-update') await damageApi.update(recordId, { ...changes, baseVersion });
      else await repairApi.update(recordId, { ...changes, baseVersion });
      ElMessage.success('已保存');
      return 'saved';
    } catch (error) {
      if (error instanceof ApiError && error.code === 'OFFLINE') {
        offline.enqueue(kind, { id: recordId, changes, baseVersion }, label);
        ElMessage.warning('当前网络不可用，修改已放入离线队列，联网后会自动同步');
        return 'queued';
      }
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        const details = (error.details ?? {}) as { currentVersion?: number; serverRecord?: Record<string, unknown> };
        offline.addConflict({
          id: `manual-${recordId}`,
          kind,
          label,
          recordId,
          localPayload: changes,
          serverRecord: details.serverRecord ?? null,
          currentVersion: details.currentVersion ?? null,
          message: error.message,
        });
        ElNotification({
          type: 'warning',
          title: '保存时发生版本冲突',
          message: '这条记录刚被其他设备修改过。你的修改已保留在「同步冲突」面板（页面右上角），请对比后决定保留哪一版。',
          duration: 10_000,
        });
        return 'conflict';
      }
      ElMessage.error(messageOf(error));
      return 'failed';
    }
  }

  return { save };
}
