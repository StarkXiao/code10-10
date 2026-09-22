import { defineStore } from 'pinia';
import { ref } from 'vue';

export type OfflineOpKind = 'wear-log' | 'damage-create' | 'repair-create' | 'damage-update' | 'repair-update';

export interface QueuedOperation {
  id: string;
  kind: OfflineOpKind;
  /** 给用户看的一句话，例如「破损登记 · 灰色羊毛衫」，同步结果与冲突提示都引用它 */
  label: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

/** 多端合并冲突：本地修改与服务器当前版本对不上时，留在这里等用户拍板 */
export interface SyncConflict {
  id: string;
  kind: OfflineOpKind;
  label: string;
  /** 冲突记录的 id（破损事件或修补记录） */
  recordId: string;
  /** 本地（离线时）提交的修改内容 */
  localPayload: Record<string, unknown>;
  /** 冲突时服务器上的当前记录（409 响应带回） */
  serverRecord: Record<string, unknown> | null;
  currentVersion: number | null;
  message: string;
  detectedAt: number;
}

const QUEUE_KEY = 'gml.offlineQueue';
const CONFLICTS_KEY = 'gml.offlineConflicts';

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** 兼容旧版本队列：那时只有穿着打点、且没有 label 字段 */
function normalize(op: Partial<QueuedOperation> & { id: string }): QueuedOperation {
  return {
    id: op.id,
    kind: op.kind ?? 'wear-log',
    label: op.label ?? '穿着打点',
    payload: op.payload ?? {},
    createdAt: op.createdAt ?? Date.now(),
  };
}

/**
 * 离线队列（项目文档 F22）：
 * 断网时把「穿着打点 / 破损登记 / 修补登记 / 记录编辑」先落到本地，
 * 恢复网络后按 clientOpId 幂等同步（同一条记录重放几次都只建一次）；
 * 编辑类操作带 baseVersion 做乐观锁合并，合不上就转入 conflicts 等用户处理。
 */
export const useOfflineQueueStore = defineStore('offlineQueue', () => {
  const queue = ref<QueuedOperation[]>((load< Array<Partial<QueuedOperation> & { id: string }> >(QUEUE_KEY, [])).map(normalize));
  const conflicts = ref<SyncConflict[]>(load<SyncConflict[]>(CONFLICTS_KEY, []));
  const syncing = ref(false);
  const lastSyncAt = ref<number | null>(null);
  const lastError = ref('');

  function persist(): void {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.value));
    localStorage.setItem(CONFLICTS_KEY, JSON.stringify(conflicts.value));
  }

  function enqueue(kind: OfflineOpKind, payload: Record<string, unknown>, label: string): QueuedOperation {
    const op: QueuedOperation = {
      id: `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      label,
      payload,
      createdAt: Date.now(),
    };
    queue.value.push(op);
    persist();
    return op;
  }

  function remove(ids: string[]): void {
    queue.value = queue.value.filter((op) => !ids.includes(op.id));
    persist();
  }

  function addConflict(conflict: Omit<SyncConflict, 'detectedAt'>): void {
    // 同一条记录的冲突只留最新一次，避免反复提示堆叠
    conflicts.value = [...conflicts.value.filter((c) => c.id !== conflict.id), { ...conflict, detectedAt: Date.now() }];
    persist();
  }

  function resolveConflict(id: string): void {
    conflicts.value = conflicts.value.filter((c) => c.id !== id);
    persist();
  }

  return { queue, conflicts, syncing, lastSyncAt, lastError, enqueue, remove, addConflict, resolveConflict, persist };
});
