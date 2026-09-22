<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Warning, CircleClose } from '@element-plus/icons-vue';
import { useOfflineQueueStore } from '../stores/offlineQueue';

/**
 * 离线同步状态与冲突结果中心：
 * - 顶栏的「离线待同步 N」点开看队列里都是什么
 * - 同步冲突 / 业务拒绝的结果留存在这里，逐条向用户说明合并结果，确认后才消失
 */
const offline = useOfflineQueueStore();
const router = useRouter();
const drawer = ref(false);

const KIND_LABEL: Record<string, string> = {
  'wear-log': '穿着打点',
  'damage-create': '破损登记',
  'repair-create': '修补登记',
};

const conflicts = computed(() => offline.issues.filter((i) => i.outcome === 'conflict'));
const rejected = computed(() => offline.issues.filter((i) => i.outcome === 'rejected'));

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/** 从冲突详情里取出"当前版本 vs 你的版本"，给用户讲清楚合并结果 */
function conflictVersions(issue: { conflict?: unknown }): string {
  const c = (issue.conflict ?? {}) as { expectedVersion?: number; currentVersion?: number };
  if (c.expectedVersion && c.currentVersion) {
    return `你离线时基于 v${c.expectedVersion} 编辑，服务端已经是 v${c.currentVersion}`;
  }
  return '';
}

function openEntity(issue: { entityType?: string; entityId?: string }): void {
  if (!issue.entityId) return;
  if (issue.entityType === 'damage_event') {
    void router.push({ name: 'damage-detail', params: { id: issue.entityId } });
    drawer.value = false;
  } else if (issue.entityType === 'repair') {
    void router.push({ name: 'repair-detail', params: { id: issue.entityId } });
    drawer.value = false;
  }
}

function dismiss(id: string): void {
  offline.dismissIssue(id);
}

function dismissAll(): void {
  offline.clearIssues();
  ElMessage.success('已清除全部提示');
}

defineExpose({ open: () => (drawer.value = true) });
</script>

<template>
  <el-drawer v-model="drawer" title="离线记录与同步结果" size="420px" direction="rtl">
    <template #footer>
      <div v-if="offline.issues.length" style="text-align: right">
        <el-button @click="dismissAll">全部知道了</el-button>
      </div>
    </template>

    <el-alert
      v-if="offline.queue.length"
      type="info"
      :closable="false"
      show-icon
      :title="`还有 ${offline.queue.length} 条记录等待同步`"
      description="断网时登记的内容已保存在本机，恢复网络后会自动按记录版本合并，不用重复提交。"
      style="margin-bottom: 16px"
    />

    <template v-if="offline.queue.length">
      <div class="section-title">待同步队列</div>
      <el-table :data="offline.queue" size="small" style="margin-bottom: 20px">
        <el-table-column label="类型" width="86">
          <template #default="{ row }">{{ KIND_LABEL[row.kind] ?? row.kind }}</template>
        </el-table-column>
        <el-table-column label="内容">
          <template #default="{ row }">
            <div>{{ row.summary }}</div>
            <div class="muted" style="font-size: 12px">{{ formatTime(row.createdAt) }}</div>
          </template>
        </el-table-column>
      </el-table>
    </template>

    <template v-if="conflicts.length">
      <div class="section-title conflict-title">
        <el-icon><Warning /></el-icon>
        同步冲突（{{ conflicts.length }}）
      </div>
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom: 12px"
        title="多端同时修改了同一条记录"
        description="服务端保留了先同步成功的版本，你的离线修改没有覆盖它。请打开最新记录核对，把你这边仍需要的内容手动补进去。"
      />
      <el-card v-for="issue in conflicts" :key="issue.id" shadow="never" class="issue-card">
        <div class="issue-head">
          <strong>{{ issue.title }}</strong>
          <el-tag size="small" type="warning">冲突</el-tag>
        </div>
        <div class="muted" style="margin: 6px 0">{{ issue.message }}</div>
        <div v-if="conflictVersions(issue)" class="muted" style="font-size: 12px">{{ conflictVersions(issue) }}</div>
        <div class="muted" style="font-size: 12px">{{ formatTime(issue.at) }}</div>
        <div style="margin-top: 8px; display: flex; gap: 8px">
          <el-button size="small" type="primary" :disabled="!issue.entityId" @click="openEntity(issue)">
            打开最新记录核对
          </el-button>
          <el-button size="small" @click="dismiss(issue.id)">知道了</el-button>
        </div>
      </el-card>
    </template>

    <template v-if="rejected.length">
      <div class="section-title reject-title">
        <el-icon><CircleClose /></el-icon>
        无法同步（{{ rejected.length }}）
      </div>
      <el-card v-for="issue in rejected" :key="issue.id" shadow="never" class="issue-card">
        <div class="issue-head">
          <strong>{{ issue.title }}</strong>
          <el-tag size="small" type="danger">已跳过</el-tag>
        </div>
        <div class="muted" style="margin: 6px 0">{{ issue.message }}</div>
        <div class="muted" style="font-size: 12px">{{ formatTime(issue.at) }}</div>
        <div style="margin-top: 8px">
          <el-button size="small" @click="dismiss(issue.id)">知道了</el-button>
        </div>
      </el-card>
    </template>

    <el-empty
      v-if="!offline.queue.length && !offline.issues.length"
      :image-size="80"
      description="没有待同步记录，也没有冲突"
    />
  </el-drawer>
</template>

<style scoped>
.section-title {
  font-weight: 600;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.conflict-title {
  color: #b88230;
}
.reject-title {
  color: #c45656;
}
.issue-card {
  margin-bottom: 10px;
}
.issue-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
</style>
