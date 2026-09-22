<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { ArrowDown } from '@element-plus/icons-vue';
import { reminderApi } from './api';
import { getToken } from './api/client';
import { useSessionStore } from './stores/session';
import { useOfflineQueueStore } from './stores/offlineQueue';
import { useOfflineSync } from './composables/useOfflineSync';
import SyncConflicts from './components/SyncConflicts.vue';

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const offline = useOfflineQueueStore();
const badge = ref(0);
const conflictsOpen = ref(false);
let source: EventSource | null = null;
let badgeTimer: number | undefined;

const isPublicPage = computed(() => route.meta.public === true);
const activeMenu = computed(() => {
  const name = String(route.name ?? '');
  if (name === 'annotate') return 'garments';
  if (name === 'dashboard' || name === 'garments' || name === 'wear' || name === 'fabric' || name === 'reminders' || name === 'analytics' || name === 'settings') {
    return name;
  }
  return '';
});

// 离线队列：断网时把穿着打点、破损/修补登记与记录编辑先落本地，
// 恢复网络后按 clientOpId 幂等同步；编辑按 baseVersion 乐观锁合并，冲突进冲突面板。
// 必须在组件上下文里调用，否则 onMounted 不会执行（同步将永远不会启动）。
useOfflineSync();

async function refreshBadge(): Promise<void> {
  if (!getToken() || isPublicPage.value) return;
  try {
    badge.value = (await reminderApi.summary()).badge;
  } catch {
    /* 网络波动时忽略 */
  }
}

/** SSE 实时提醒；断线 30 秒后重连，其间靠 60 秒轮询兜底 */
function connectEvents(): void {
  if (!getToken() || source || isPublicPage.value) return;
  source = new EventSource(`/api/events?token=${encodeURIComponent(getToken())}`);
  source.addEventListener('reminder.created', (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as { title: string };
    ElMessage({ type: 'info', message: `新提醒：${payload.title}`, duration: 5000 });
    void refreshBadge();
  });
  source.addEventListener('reminder.updated', () => void refreshBadge());
  source.onerror = () => {
    source?.close();
    source = null;
    window.setTimeout(connectEvents, 30_000);
  };
}

onMounted(async () => {
  await session.bootstrap();
  if (getToken() && !isPublicPage.value) {
    await refreshBadge();
    connectEvents();
    badgeTimer = window.setInterval(refreshBadge, 60_000);
  }
});

// 登录/退出后要重新建立实时推送：App 只挂载一次，不能只在 onMounted 里连一次
watch(
  () => session.user?.id,
  async (userId) => {
    if (userId && !isPublicPage.value) {
      await refreshBadge();
      connectEvents();
    } else if (!userId) {
      source?.close();
      source = null;
      badge.value = 0;
    }
  },
);

onUnmounted(() => {
  source?.close();
  if (badgeTimer) window.clearInterval(badgeTimer);
});

function logout(): void {
  session.logout();
  source?.close();
  source = null;
  void router.push({ name: 'login' });
}
</script>

<template>
  <router-view v-if="isPublicPage" />
  <el-container v-else style="min-height: 100vh">
    <el-header
      style="display: flex; align-items: center; gap: 16px; background: #fff; border-bottom: 1px solid #ebeef5; padding: 0 20px"
    >
      <div style="font-weight: 600; font-size: 16px; white-space: nowrap">衣物修补日志</div>
      <el-menu mode="horizontal" :default-active="activeMenu" :ellipsis="false" style="flex: 1; border: none">
        <el-menu-item index="dashboard" @click="router.push({ name: 'dashboard' })">总览</el-menu-item>
        <el-menu-item index="garments" @click="router.push({ name: 'garments' })">衣物</el-menu-item>
        <el-menu-item index="wear" @click="router.push({ name: 'wear' })">穿着</el-menu-item>
        <el-menu-item index="fabric" @click="router.push({ name: 'fabric' })">布料</el-menu-item>
        <el-menu-item index="reminders" @click="router.push({ name: 'reminders' })">
          <el-badge :value="badge" :hidden="badge === 0" :max="99">提醒</el-badge>
        </el-menu-item>
        <el-menu-item index="analytics" @click="router.push({ name: 'analytics' })">长期使用</el-menu-item>
        <el-menu-item index="settings" @click="router.push({ name: 'settings' })">设置</el-menu-item>
      </el-menu>
      <el-tag v-if="offline.queue.length > 0" type="warning" size="small">
        离线待同步 {{ offline.queue.length }}
      </el-tag>
      <el-tag
        v-if="offline.conflicts.length > 0"
        type="danger"
        size="small"
        style="cursor: pointer"
        @click="conflictsOpen = true"
      >
        同步冲突 {{ offline.conflicts.length }}
      </el-tag>
      <el-dropdown v-if="session.user">
        <span style="cursor: pointer; display: inline-flex; align-items: center; gap: 2px">
          {{ session.user.displayName }}
          <el-icon><ArrowDown /></el-icon>
        </span>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item @click="router.push({ name: 'settings' })">设置</el-dropdown-item>
            <el-dropdown-item divided @click="logout">退出登录</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </el-header>
    <el-main style="padding: 0">
      <router-view />
    </el-main>
    <SyncConflicts v-model="conflictsOpen" />
  </el-container>
</template>
