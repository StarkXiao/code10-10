<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import {
  SEASON_LABEL,
  WEAR_FREQUENCY_BAND_LABEL,
  WEAR_INTENSITIES,
  WEAR_INTENSITY_LABEL,
  WEAR_SESSION_LABEL,
  WEAR_SESSIONS,
  type Season,
  type WearFrequencyBand,
  type WearIntensity,
  type WearSession,
} from '@gml/shared';
import { garmentApi, wearApi } from '../api';
import { ApiError, messageOf } from '../api/client';
import { useOfflineQueueStore } from '../stores/offlineQueue';
import EmptyState from '../components/EmptyState.vue';
import type { GarmentListItem, WearCalendarResponse } from '../types';

const router = useRouter();
const offline = useOfflineQueueStore();
const garments = ref<GarmentListItem[]>([]);
const calendar = ref<WearCalendarResponse | null>(null);
const month = ref(new Date().toISOString().slice(0, 7));
const busy = ref(false);

const quick = reactive({ garmentId: '', wornOn: new Date().toISOString().slice(0, 10), session: 'full_day' as WearSession, intensity: 'normal' as WearIntensity });
const batchText = ref('');
const batchReport = ref('');

const days = computed(() => {
  if (!calendar.value) return [] as Array<{ date: string; items: Array<{ garmentId: string; name: string; session: string }> }>;
  const [year, monthNum] = calendar.value.month.split('-').map(Number);
  const total = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
  return Array.from({ length: total }, (_, index) => {
    const date = `${calendar.value!.month}-${String(index + 1).padStart(2, '0')}`;
    return { date, items: calendar.value!.days[date] ?? [] };
  });
});

onMounted(async () => {
  garments.value = (await garmentApi.list({ pageSize: 100, sort: 'recent' })).items;
  await loadCalendar();
});

watch(month, loadCalendar);

async function loadCalendar(): Promise<void> {
  try {
    calendar.value = await wearApi.calendar(month.value);
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

async function logWear(): Promise<void> {
  if (!quick.garmentId) {
    ElMessage.warning('请选择衣物');
    return;
  }
  busy.value = true;
  try {
    const result = await wearApi.create({ ...quick });
    ElMessage.success(result.duplicate ? '这一天已经记过了（不会重复计数）' : '已记录');
    await loadCalendar();
  } catch (error) {
    // 只有真正的网络故障才入队；参数非法之类的错误要如实报出来，否则会变成永远同步不成功的僵尸记录
    if (error instanceof ApiError && error.code === 'OFFLINE') {
      const garment = garments.value.find((g) => g.id === quick.garmentId);
      offline.enqueue({
        kind: 'wear-log',
        payload: { ...quick },
        summary: `${garment?.name ?? quick.garmentId} · ${quick.wornOn} 穿着打点`,
      });
      ElMessage.warning('当前网络不可用，已放入离线队列，联网后会自动同步');
    } else {
      ElMessage.error(messageOf(error));
    }
  } finally {
    busy.value = false;
  }
}

async function submitBatch(): Promise<void> {
  const lines = batchText.value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    ElMessage.warning('每行填一条，格式：2026-09-01,灰色羊毛衫,全天');
    return;
  }
  const logs: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  for (const line of lines) {
    const [date, name, session] = line.split(/[,，]/u).map((part) => part?.trim());
    const garment = garments.value.find((g) => g.name === name || g.code === name);
    if (!date || !garment) {
      errors.push(`无法匹配：${line}`);
      continue;
    }
    logs.push({
      garmentId: garment.id,
      wornOn: date,
      session: (WEAR_SESSIONS.includes(session as WearSession) ? session : 'full_day') as WearSession,
      clientOpId: `batch-${date}-${garment.id}`,
    });
  }
  if (logs.length === 0) {
    ElMessage.error(`没有可导入的行：${errors.join('；')}`);
    return;
  }
  busy.value = true;
  try {
    const result = await wearApi.batch(logs);
    batchReport.value = `新增 ${result.created} 条，重复跳过 ${result.duplicates} 条，失败 ${result.failed} 条${errors.length ? `；未匹配 ${errors.length} 行` : ''}`;
    ElMessage.success(batchReport.value);
    batchText.value = '';
    await loadCalendar();
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">穿着记录</h1>
        <div class="page-subtitle">穿着次数是"每穿成本"和"穿着频率分档"的原始数据；同一天同一件只算一次</div>
      </div>
      <el-tag v-if="offline.queue.length" type="warning">离线待同步 {{ offline.queue.length }} 条</el-tag>
    </div>

    <el-row :gutter="12">
      <el-col :xs="24" :md="8">
        <el-card shadow="never">
          <template #header>快速打点</template>
          <el-select v-model="quick.garmentId" filterable placeholder="选衣物" style="width: 100%">
            <el-option v-for="item in garments" :key="item.id" :value="item.id" :label="`${item.name}（${item.code}）`" />
          </el-select>
          <el-date-picker v-model="quick.wornOn" type="date" value-format="YYYY-MM-DD" style="width: 100%; margin-top: 8px" />
          <el-select v-model="quick.session" style="width: 100%; margin-top: 8px">
            <el-option v-for="item in WEAR_SESSIONS" :key="item" :value="item" :label="WEAR_SESSION_LABEL[item]" />
          </el-select>
          <el-select v-model="quick.intensity" style="width: 100%; margin-top: 8px">
            <el-option v-for="item in WEAR_INTENSITIES" :key="item" :value="item" :label="WEAR_INTENSITY_LABEL[item]" />
          </el-select>
          <el-button type="primary" style="width: 100%; margin-top: 10px" :loading="busy" @click="logWear">记录</el-button>
        </el-card>

        <el-card shadow="never" style="margin-top: 12px">
          <template #header>批量补录</template>
          <div class="muted" style="margin-bottom: 6px">每行一条：日期,衣物名称或编号,时长档</div>
          <el-input
            v-model="batchText"
            type="textarea"
            :rows="5"
            placeholder="2026-09-01,灰色羊毛衫,全天&#10;2026-09-03,G-2026-0001,半天"
          />
          <el-button style="width: 100%; margin-top: 8px" :loading="busy" @click="submitBatch">导入</el-button>
          <div v-if="batchReport" class="muted" style="margin-top: 8px">{{ batchReport }}</div>
        </el-card>
      </el-col>

      <el-col :xs="24" :md="16">
        <el-card shadow="never">
          <template #header>
            <div style="display: flex; justify-content: space-between; align-items: center">
              <span>穿着日历</span>
              <el-date-picker v-model="month" type="month" value-format="YYYY-MM" style="width: 160px" size="small" />
            </div>
          </template>
          <div v-if="calendar" class="stat-row" style="margin-bottom: 12px">
            <div class="stat-block">
              <div class="stat-value">{{ calendar.totals.wearCount }}</div>
              <div class="stat-label">本月穿着次数</div>
            </div>
            <div class="stat-block">
              <div class="stat-value">{{ calendar.totals.distinctGarments }}</div>
              <div class="stat-label">涉及衣物</div>
            </div>
            <div class="stat-block">
              <div class="stat-value">{{ calendar.totals.averagePerDay }}</div>
              <div class="stat-label">日均</div>
            </div>
          </div>

          <div style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px">
            <div
              v-for="day in days"
              :key="day.date"
              :style="{
                border: '1px solid #ebeef5',
                borderRadius: '6px',
                padding: '6px',
                minHeight: '72px',
                background: day.items.length ? '#fff7ed' : '#fafafa',
              }"
            >
              <div class="muted" style="font-size: 11px">{{ day.date.slice(8) }}</div>
              <div v-for="item in day.items.slice(0, 3)" :key="item.garmentId + item.session" style="font-size: 11px; cursor: pointer" @click="router.push({ name: 'garment-detail', params: { id: item.garmentId } })">
                {{ item.name }}
              </div>
              <div v-if="day.items.length > 3" class="muted" style="font-size: 11px">+{{ day.items.length - 3 }}</div>
            </div>
          </div>
        </el-card>

        <el-card shadow="never" style="margin-top: 12px">
          <template #header>穿得最多 / 最少的衣物</template>
          <el-table :data="garments" size="small" max-height="320">
            <el-table-column prop="name" label="衣物" />
            <el-table-column prop="code" label="编号" width="130" />
            <el-table-column prop="wearCount" label="穿着次数" width="100" />
            <el-table-column label="月均" width="100">
              <template #default="{ row }">{{ row.perMonth }} 次</template>
            </el-table-column>
            <el-table-column label="频率档" width="170">
              <template #default="{ row }">{{ WEAR_FREQUENCY_BAND_LABEL[row.frequencyBand as WearFrequencyBand] }}</template>
            </el-table-column>
            <el-table-column label="每穿成本" width="110">
              <template #default="{ row }">{{ row.costPerWear ?? '—' }}</template>
            </el-table-column>
          </el-table>
          <EmptyState v-if="garments.length === 0" title="还没有衣物档案" />
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>
