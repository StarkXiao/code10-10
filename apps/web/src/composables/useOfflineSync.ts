import { onMounted, onUnmounted } from 'vue';
import { ElMessage, ElNotification } from 'element-plus';
import { syncApi, type SyncOpResult } from '../api';
import { ApiError } from '../api/client';
import { useOfflineQueueStore } from '../stores/offlineQueue';
import { useSessionStore } from '../stores/session';

const KIND_LABEL: Record<string, string> = {
  'wear-log': '穿着打点',
  'damage-create': '破损登记',
  'repair-create': '修补登记',
};

/**
 * 联网且已登录时，把离线队列整批同步给后端：
 *   ok/duplicate → 移出纳队列
 *   rejected     → 业务错误（再试也不会成功），移出并留存提示
 *   conflict     → 多端版本冲突，移出并弹出冲突结果，引导用户去合并
 * 网络层失败（仍断网/5xx）：整批保留，等下次同步。
 */
export function useOfflineSync(): void {
  const offline = useOfflineQueueStore();
  const session = useSessionStore();
  let timer: number | undefined;

  async function sync(): Promise<void> {
    if (offline.syncing || offline.queue.length === 0) return;
    if (!navigator.onLine || !session.user) return;
    offline.syncing = true;
    try {
      const ops = offline.queue.map((op) => ({
        opId: op.id,
        kind: op.kind,
        payload: op.payload,
        ...(op.kind === 'repair-create' && op.baseDamageVersion
          ? { expectedDamageVersion: op.baseDamageVersion }
          : {}),
      }));
      offline.markAttempted(offline.queue.map((op) => op.id));

      let results: SyncOpResult[];
      try {
        results = (await syncApi.batch(ops)).results;
      } catch (error) {
        // 断网或服务器出错：整批保留，等 online 事件 / 下一轮定时器
        if (error instanceof ApiError && error.code !== 'OFFLINE') {
          offline.lastError = error.message;
        }
        return;
      }

      const done: string[] = [];
      for (const result of results) {
        if (result.status === 'ok' || result.status === 'duplicate') {
          done.push(result.opId);
          continue;
        }
        const op = offline.queue.find((item) => item.id === result.opId);
        if (result.status === 'conflict' || result.status === 'rejected') {
          done.push(result.opId);
          offline.addIssue({
            opId: result.opId,
            kind: result.kind,
            outcome: result.status,
            title:
              result.status === 'conflict'
                ? `同步冲突：${KIND_LABEL[result.kind] ?? result.kind}未按你的版本保存`
                : `${KIND_LABEL[result.kind] ?? result.kind}无法同步`,
            message: result.message ?? '服务端拒绝了这条记录',
            conflict: result.conflict,
            entityType: result.entityType,
            entityId: result.entityId,
            code: result.code,
          });
        }
      }
      if (done.length > 0) offline.remove(done);
      offline.lastSyncAt = Date.now();
      offline.lastError = '';

      const summary = results.reduce(
        (acc, r) => {
          acc[r.status] += 1;
          return acc;
        },
        { ok: 0, duplicate: 0, rejected: 0, conflict: 0 } as Record<SyncOpResult['status'], number>,
      );
      if (summary.ok > 0 || summary.duplicate > 0) {
        ElMessage({
          type: 'success',
          duration: 4000,
          message: `离线记录已同步 ${summary.ok + summary.duplicate} 条${summary.duplicate ? `（其中 ${summary.duplicate} 条为重复提交，已去重）` : ''}`,
        });
      }
      if (summary.conflict > 0 || summary.rejected > 0) {
        const conflictIssues = offline.issues.filter((i) => i.outcome === 'conflict');
        const latest = conflictIssues[0];
        ElNotification({
          type: 'warning',
          duration: 0,
          title:
            summary.conflict > 0
              ? `有 ${summary.conflict} 条记录与其他端冲突，需要你确认合并结果`
              : `有 ${summary.rejected} 条离线记录无法同步`,
          message:
            latest?.message ??
            offline.issues.find((i) => i.outcome === 'rejected')?.message ??
            '点击查看详情',
        });
      }
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
