import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

/** 离线队列支持的操作：穿着打点 / 破损登记 / 修补登记 */
export type QueuedKind = 'wear-log' | 'damage-create' | 'repair-create';

export interface QueuedOperation {
  id: string;
  kind: QueuedKind;
  payload: Record<string, unknown>;
  /** repair-create 专用：本地提交时看到的破损版本，用于多端冲突检测 */
  baseDamageVersion?: number;
  /** 给用户看的一句话描述（断网时无法事后拼装名称，入队时就固化） */
  summary: string;
  createdAt: number;
  attempts: number;
}

/**
 * 同步冲突/拒绝结果（来自 /api/sync 逐条回报）。
 * 同步完成后不直接丢弃：留到用户手动"知道了"，保证冲突结果一定被看到。
 */
export interface SyncIssue {
  id: string;
  opId: string;
  kind: QueuedKind;
  outcome: 'conflict' | 'rejected';
  title: string;
  message: string;
  conflict?: unknown;
  /** 冲突记录的跳转地址（有的话） */
  entityType?: string;
  entityId?: string;
  code?: string;
  at: number;
}

const STORAGE_KEY = 'gml.offlineQueue.v2';
const ISSUES_KEY = 'gml.syncIssues.v1';

function load<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * 旧版（只支持穿着打点）队列的一次性迁移：
 * 老条目结构是 { id, kind:'wear-log', payload }，直接吸收进新队列。
 */
function migrateV1Queue(): QueuedOperation[] {
  const migrated = load<QueuedOperation>(STORAGE_KEY);
  if (migrated.length > 0) return migrated;
  try {
    const raw = localStorage.getItem('gml.offlineQueue');
    if (!raw) return [];
    const legacy = JSON.parse(raw) as Array<{
      id: string;
      kind?: string;
      payload: Record<string, unknown>;
      createdAt?: number;
    }>;
    if (!Array.isArray(legacy) || legacy.length === 0) return [];
    const ops = legacy.map((item) => ({
      id: item.id,
      kind: 'wear-log' as const,
      payload: item.payload,
      summary: `穿着打点 · ${String(item.payload?.wornOn ?? '')}`,
      createdAt: item.createdAt ?? Date.now(),
      attempts: 0,
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ops));
    localStorage.removeItem('gml.offlineQueue');
    return ops;
  } catch {
    return [];
  }
}

let opSeq = 0;
function newOpId(): string {
  opSeq += 1;
  return `op-${Date.now().toString(36)}-${opSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 离线队列（项目文档 F22）：
 * 断网时把"穿着打点 / 破损登记 / 修补登记"先落到本地，
 * 恢复网络后整批发给 /api/sync，按 clientOpId 幂等写入；
 * 多端并发修改同一记录时，服务端按记录版本回报冲突，结果留存在 syncIssues 里提示用户。
 */
export const useOfflineQueueStore = defineStore('offlineQueue', () => {
  const queue = ref<QueuedOperation[]>(migrateV1Queue());
  const issues = ref<SyncIssue[]>(load(ISSUES_KEY));
  const syncing = ref(false);
  const lastSyncAt = ref<number | null>(null);
  const lastError = ref('');

  const pendingCount = computed(() => queue.value.length);
  const conflictCount = computed(() => issues.value.filter((i) => i.outcome === 'conflict').length);

  function persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue.value));
  }

  function persistIssues(): void {
    localStorage.setItem(ISSUES_KEY, JSON.stringify(issues.value));
  }

  function enqueue(input: {
    kind: QueuedKind;
    payload: Record<string, unknown>;
    summary: string;
    baseDamageVersion?: number;
  }): QueuedOperation {
    const op: QueuedOperation = {
      id: newOpId(),
      kind: input.kind,
      payload: input.payload,
      baseDamageVersion: input.baseDamageVersion,
      summary: input.summary,
      createdAt: Date.now(),
      attempts: 0,
    };
    queue.value.push(op);
    persist();
    return op;
  }

  function remove(ids: string[]): void {
    const set = new Set(ids);
    queue.value = queue.value.filter((op) => !set.has(op.id));
    persist();
  }

  function markAttempted(ids: string[]): void {
    const set = new Set(ids);
    for (const op of queue.value) {
      if (set.has(op.id)) op.attempts += 1;
    }
    persist();
  }

  function addIssue(issue: Omit<SyncIssue, 'id' | 'at'>): void {
    issues.value.unshift({ ...issue, id: `issue-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: Date.now() });
    // 只保留最近 50 条，避免本地存储无限增长
    if (issues.value.length > 50) issues.value = issues.value.slice(0, 50);
    persistIssues();
  }

  function dismissIssue(id: string): void {
    issues.value = issues.value.filter((issue) => issue.id !== id);
    persistIssues();
  }

  function clearIssues(): void {
    issues.value = [];
    persistIssues();
  }

  return {
    queue,
    issues,
    syncing,
    lastSyncAt,
    lastError,
    pendingCount,
    conflictCount,
    enqueue,
    remove,
    markAttempted,
    addIssue,
    dismissIssue,
    clearIssues,
    persist,
  };
});
