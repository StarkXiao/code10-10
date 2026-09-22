<script setup lang="ts">
/**
 * 同步冲突面板：离线编辑与服务器最新版本合不上（版本冲突）时，
 * 在这里向用户摆出「本地修改 vs 服务器当前值」，由用户逐条决定——
 * 放弃本地修改，或以本地内容覆盖服务器最新版本。
 */
import { computed, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useQueryClient } from '@tanstack/vue-query';
import {
  CAUSE_GUESS_LABEL,
  RESULT_RATING_LABEL,
  SEVERITY_LABEL,
  type CauseGuess,
  type ResultRating,
  type Severity,
} from '@gml/shared';
import { damageApi, repairApi, wardrobeApi } from '../api';
import { ApiError, messageOf } from '../api/client';
import { useOfflineQueueStore, type SyncConflict } from '../stores/offlineQueue';
import type { DictionaryResponse } from '../types';

const visible = defineModel<boolean>({ required: true });
const offline = useOfflineQueueStore();
const queryClient = useQueryClient();
const dict = ref<DictionaryResponse | null>(null);
const busyId = ref('');

const conflicts = computed(() => offline.conflicts);

// 打开面板时拉一次字典，把 damageTypeId / partId / stitchId 翻译成中文名
watch(visible, async (open) => {
  if (open && !dict.value) {
    try {
      dict.value = await wardrobeApi.dictionary();
    } catch {
      /* 字典拿不到就退化为显示原始值 */
    }
  }
});

const FIELD_LABELS: Record<string, string> = {
  damageTypeId: '破损类型',
  severity: '严重度',
  partId: '部位',
  detectedAt: '发现日期',
  description: '描述',
  causeGuess: '原因猜测',
  measurableSize: '实测尺寸',
  stitchId: '针法',
  stitchSecondaryIds: '辅助针法',
  threadType: '线材',
  threadColor: '线色',
  durationMinutes: '耗时（分钟）',
  cost: '花费',
  resultRating: '满意度',
  observationDays: '观察期（天）',
  note: '备注',
};

function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (key === 'severity') return SEVERITY_LABEL[value as Severity] ?? String(value);
  if (key === 'causeGuess') return CAUSE_GUESS_LABEL[value as CauseGuess] ?? String(value);
  if (key === 'resultRating') return RESULT_RATING_LABEL[value as ResultRating] ?? String(value);
  if (key === 'damageTypeId') return dict.value?.damageTypes.find((d) => d.id === value)?.name ?? String(value);
  if (key === 'partId') return dict.value?.partsFlat.find((p) => p.id === value)?.name ?? String(value);
  if (key === 'stitchId') return dict.value?.stitches.find((s) => s.id === value)?.name ?? String(value);
  if (key === 'stitchSecondaryIds' && Array.isArray(value)) {
    const names = value.map((id) => dict.value?.stitches.find((s) => s.id === id)?.name ?? String(id));
    return names.length ? names.join('、') : '—';
  }
  if (key === 'measurableSize' && typeof value === 'object') {
    const size = value as { lengthMm?: number; widthMm?: number };
    return `${size.lengthMm ?? 0} × ${size.widthMm ?? 0} mm`;
  }
  // 服务器存的是 DateTime、表单填的是日期串：按天对齐再比较，避免"其实一样却显示成不同"
  if (key.endsWith('At')) return String(value).slice(0, 10);
  // 金额在服务器是 Decimal（序列化成字符串），本地是数字：统一成数字再比
  if (key === 'cost') return String(Number(value));
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 本地改了哪些字段 + 服务器上同名字段的当前值，逐行对比 */
function rowsOf(conflict: SyncConflict): Array<{ key: string; label: string; local: string; server: string; differs: boolean }> {
  return Object.keys(conflict.localPayload)
    .filter((key) => key in FIELD_LABELS)
    .map((key) => {
      const local = formatValue(key, conflict.localPayload[key]);
      const server = conflict.serverRecord ? formatValue(key, conflict.serverRecord[key]) : '（记录已不存在）';
      return { key, label: FIELD_LABELS[key], local, server, differs: local !== server };
    });
}

async function discardLocal(conflict: SyncConflict): Promise<void> {
  await ElMessageBox.confirm('放弃后，你在离线时做的这些修改将被丢弃，且不可恢复。', '放弃本地修改？', {
    confirmButtonText: '放弃我的修改',
    cancelButtonText: '再想想',
    type: 'warning',
  });
  offline.resolveConflict(conflict.id);
  ElMessage.info(`已放弃「${conflict.label}」的本地修改，以服务器版本为准`);
}

/** 以本地修改覆盖：带上服务器当前版本号重新合并；若期间又被改过，会再次冲突并刷新对比 */
async function overwriteServer(conflict: SyncConflict): Promise<void> {
  if (conflict.currentVersion === null) {
    ElMessage.error('拿不到服务器当前版本，无法覆盖；请放弃本地修改或稍后再试');
    return;
  }
  busyId.value = conflict.id;
  try {
    const body = { ...conflict.localPayload, baseVersion: conflict.currentVersion };
    if (conflict.kind === 'damage-update') {
      await damageApi.update(conflict.recordId, body);
    } else {
      await repairApi.update(conflict.recordId, body);
    }
    offline.resolveConflict(conflict.id);
    ElMessage.success(`已用你的修改覆盖「${conflict.label}」`);
    await queryClient.invalidateQueries();
  } catch (error) {
    if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
      const details = (error.details ?? {}) as { currentVersion?: number; serverRecord?: Record<string, unknown> };
      offline.addConflict({
        ...conflict,
        serverRecord: details.serverRecord ?? conflict.serverRecord,
        currentVersion: details.currentVersion ?? conflict.currentVersion,
        message: error.message,
      });
      ElMessage.warning('服务器版本又变化了，请核对最新对比后再决定');
    } else if (error instanceof ApiError && error.code === 'NOT_FOUND') {
      offline.resolveConflict(conflict.id);
      ElMessage.warning('服务器上这条记录已被删除，本地修改已一并清除');
    } else {
      ElMessage.error(messageOf(error));
    }
  } finally {
    busyId.value = '';
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="同步冲突：选择保留哪一版" width="720px">
    <el-alert
      type="warning"
      :closable="false"
      style="margin-bottom: 12px"
      title="这些离线修改与服务器上的最新版本冲突"
      description="多半是另一台设备（或另一个标签页）在你离线期间改过同一条记录。逐条对比后选择：放弃本地修改，或用你的修改覆盖服务器。"
    />
    <el-empty v-if="conflicts.length === 0" description="没有待处理的冲突" />
    <el-card v-for="conflict in conflicts" :key="conflict.id" shadow="never" style="margin-bottom: 12px">
      <template #header>
        <div style="display: flex; justify-content: space-between; align-items: center">
          <span style="font-weight: 600">{{ conflict.label }}</span>
          <span class="muted" style="font-size: 12px">
            服务器当前版本 v{{ conflict.currentVersion ?? '?' }} · 冲突于 {{ new Date(conflict.detectedAt).toLocaleString('zh-CN') }}
          </span>
        </div>
      </template>
      <el-table :data="rowsOf(conflict)" size="small">
        <el-table-column prop="label" label="字段" width="110" />
        <el-table-column label="我的修改（离线时）">
          <template #default="{ row }">
            <span :style="{ fontWeight: row.differs ? 600 : 400 }">{{ row.local }}</span>
          </template>
        </el-table-column>
        <el-table-column label="服务器当前值">
          <template #default="{ row }">
            <span :class="{ muted: !row.differs }">{{ row.server }}</span>
          </template>
        </el-table-column>
      </el-table>
      <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px">
        <el-button size="small" :disabled="busyId === conflict.id" @click="discardLocal(conflict)">放弃我的修改</el-button>
        <el-button size="small" type="primary" :loading="busyId === conflict.id" @click="overwriteServer(conflict)">
          以我的修改覆盖
        </el-button>
      </div>
    </el-card>
  </el-dialog>
</template>
