import { onMounted, onUnmounted } from 'vue';
import { ElMessage, ElNotification } from 'element-plus';
import { damageApi, repairApi, wearApi } from '../api';
import { ApiError, messageOf } from '../api/client';
import { useOfflineQueueStore, type QueuedOperation } from '../stores/offlineQueue';
import { useSessionStore } from '../stores/session';

/**
 * 联网且已登录时，把离线队列同步给后端。
 * 创建类操作按 clientOpId 幂等；编辑类操作带 baseVersion 做乐观锁合并，
 * 合不上（VERSION_CONFLICT）就从队列挪到 conflicts，由用户在冲突面板里拍板。
 */
export function useOfflineSync(): void {
  const offline = useOfflineQueueStore();
  const session = useSessionStore();
  let timer: number | undefined;

  async function replay(op: QueuedOperation): Promise<void> {
    switch (op.kind) {
      case 'wear-log':
        await wearApi.create({ ...op.payload, clientOpId: op.id });
        return;
      case 'damage-create':
        await damageApi.create({ ...op.payload, clientOpId: op.id });
        return;
      case 'repair-create':
        await repairApi.create({ ...op.payload, clientOpId: op.id });
        return;
      case 'damage-update':
        await damageApi.update(String(op.payload.id), { ...(op.payload.changes as object), baseVersion: op.payload.baseVersion });
        return;
      case 'repair-update':
        await repairApi.update(String(op.payload.id), { ...(op.payload.changes as object), baseVersion: op.payload.baseVersion });
        return;
    }
  }

  async function sync(): Promise<void> {
    if (offline.syncing || offline.queue.length === 0) return;
    if (!navigator.onLine || !session.user) return;
    offline.syncing = true;
    const done: string[] = [];
    const rejected: string[] = [];
    let conflictCount = 0;
    try {
      for (const op of offline.queue) {
        try {
          await replay(op);
          done.push(op.id);
        } catch (error) {
          // 断网：保留在队列里，等下次同步
          if (error instanceof ApiError && error.code === 'OFFLINE') break;
          // 版本冲突：本地修改与服务器当前版本对不上。
          // 不能静默丢弃（用户离线时填的内容会丢），也不能强盖（会吃掉别人改的内容），
          // 挪进冲突列表，提示用户逐条决定保留哪一版。
          if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
            const details = (error.details ?? {}) as { currentVersion?: number; serverRecord?: Record<string, unknown> };
            offline.addConflict({
              id: op.id,
              kind: op.kind,
              label: op.label,
              recordId: String(op.payload.id ?? ''),
              localPayload: (op.payload.changes as Record<string, unknown>) ?? op.payload,
              serverRecord: details.serverRecord ?? null,
              currentVersion: details.currentVersion ?? null,
              message: error.message,
            });
            conflictCount += 1;
            done.push(op.id);
            continue;
          }
          // 业务错误（衣物已退役、日期非法等）：再重试一万次也不会成功，
          // 直接丢弃并告诉用户，否则队列会永远卡住、角标永远消不掉。
          offline.lastError = messageOf(error);
          rejected.push(messageOf(error));
          done.push(op.id);
        }
      }
      if (done.length > 0) offline.remove(done);
      if (rejected.length > 0) {
        ElMessage({
          type: 'warning',
          duration: 8000,
          message: `有 ${rejected.length} 条离线记录无法同步（已跳过）：${rejected[0]}`,
        });
      }
      if (conflictCount > 0) {
        ElNotification({
          type: 'warning',
          title: '发现同步冲突',
          message: `有 ${conflictCount} 条离线修改与服务器上的最新版本冲突，请点击顶部「同步冲突」逐条处理。`,
          duration: 10_000,
        });
      }
      offline.lastSyncAt = Date.now();
    } finally {
      offline.syncing = false;
    }
  }

  onMounted(() => {
    void sync();
    window.addEventListener('online', sync);
    timer = window.setInterval(sync, 30_000);
  });

  onUnmounted(() => {
    window.removeEventListener('online', sync);
    if (timer) window.clearInterval(timer);
  });
}
