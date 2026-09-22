<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowDown } from '@element-plus/icons-vue';
import {
  DAMAGE_STATUS_LABEL,
  DAMAGE_TERMINAL_STATUSES,
  DISPOSITION_LABEL,
  DISPOSITIONS,
  GARMENT_CATEGORY_LABEL,
  GARMENT_STATUS_LABEL,
  KNIT_OR_WOVEN_LABEL,
  MATERIAL_PRIMARY_LABEL,
  PHOTO_VIEW_LABEL,
  REPAIR_STATUS_LABEL,
  SEASON_LABEL,
  SEVERITY_LABEL,
  VERDICT_LABEL,
  WEAR_FREQUENCY_BAND_LABEL,
  type DamageStatus,
  type Disposition,
  type GarmentCategory,
  type GarmentStatus,
  type KnitOrWoven,
  type MaterialPrimary,
  type PhotoView,
  type RepairStatus,
  type Season,
  type Severity,
  type Verdict,
} from '@gml/shared';
import { garmentApi, wearApi } from '../api';
import { ApiError, getToken, messageOf, photoFileUrl } from '../api/client';
import HealthScoreCard from '../components/HealthScoreCard.vue';
import EmptyState from '../components/EmptyState.vue';
import PhotoUploader from '../components/PhotoUploader.vue';
import { useOfflineQueueStore } from '../stores/offlineQueue';

const route = useRoute();
const router = useRouter();
const queryClient = useQueryClient();
const offline = useOfflineQueueStore();
const garmentId = String(route.params.id);
const busy = ref(false);
const retireDialog = ref(false);
const retireForm = reactive({ disposition: 'upcycle' as Disposition, dispositionNote: '' });

const detailQuery = useQuery({
  queryKey: ['garment', garmentId],
  queryFn: () => garmentApi.detail(garmentId),
});
const timelineQuery = useQuery({
  queryKey: ['garment', garmentId, 'timeline'],
  queryFn: () => garmentApi.timeline(garmentId),
});

const detail = computed(() => detailQuery.data.value);
const garment = computed(() => detail.value?.garment);
const stats = computed(() => detail.value?.stats);
const damages = computed(() => detail.value?.damages ?? []);
const photos = computed(() => detail.value?.photos ?? []);
const openDamageIds = computed(
  () => new Set(damages.value.filter((d) => !DAMAGE_TERMINAL_STATUSES.includes(d.status as DamageStatus)).map((d) => d.id)),
);

function photoUrl(photoId: string): string {
  return photoFileUrl(photoId);
}

function lastReview(reviews: Array<{ verdict: string; reviewedAt: string }>) {
  return reviews.at(-1) ?? null;
}

async function refresh(): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['garment', garmentId] }),
    queryClient.invalidateQueries({ queryKey: ['garments'] }),
    queryClient.invalidateQueries({ queryKey: ['reminders'] }),
    queryClient.invalidateQueries({ queryKey: ['wardrobe'] }),
  ]);
}

async function wearToday(): Promise<void> {
  busy.value = true;
  const today = new Date().toISOString().slice(0, 10);
  try {
    const result = await wearApi.create({ garmentId, wornOn: today, session: 'full_day' });
    ElMessage.success(result.duplicate ? '今天已经记过一次了' : '已记录今天穿着');
    await refresh();
  } catch (error) {
    // 只有断网才入队；其他错误（比如衣物已退役）必须如实提示
    if (error instanceof ApiError && error.code === 'OFFLINE') {
      offline.enqueue('wear-log', { garmentId, wornOn: today, session: 'full_day' }, `穿着打点 · ${garment.value?.name ?? ''}`);
      ElMessage.warning('暂时没连上服务器，已放入离线队列，联网后自动同步');
    } else {
      ElMessage.error(messageOf(error));
    }
  } finally {
    busy.value = false;
  }
}

async function markWashed(): Promise<void> {
  try {
    const result = await garmentApi.washed(garmentId);
    ElMessage.success(`已记录清洗，计数器归零（同时关闭 ${result.closedReminders} 条洗护提醒）`);
    await refresh();
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

async function retire(): Promise<void> {
  busy.value = true;
  try {
    const result = await garmentApi.retire(garmentId, {
      disposition: retireForm.disposition,
      dispositionNote: retireForm.dispositionNote || undefined,
    });
    ElMessage.success(`已退役，同时失效 ${result.expiredDamageCount} 个未处理破损的提醒`);
    retireDialog.value = false;
    await refresh();
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    busy.value = false;
  }
}

async function restore(): Promise<void> {
  try {
    await garmentApi.restore(garmentId);
    ElMessage.success('已恢复为在用状态');
    await refresh();
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

async function removeGarment(): Promise<void> {
  try {
    await ElMessageBox.confirm('删除后档案进入软删除状态，可以在数据库里恢复。确定删除？', '确认删除', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await garmentApi.remove(garmentId);
    ElMessage.success('已删除');
    await router.push({ name: 'garments' });
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

async function exportMarkdown(): Promise<void> {
  const response = await fetch(`/api/export/garments/${garmentId}.md`, {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  const blob = new Blob([await response.text()], { type: 'text/markdown;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${garment.value?.code ?? 'garment'}.md`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function openPrint(): void {
  window.open(`/api/print/garment/${garmentId}?token=${encodeURIComponent(getToken())}`, '_blank');
}

function openWorksheet(damageId: string): void {
  window.open(`/api/print/repair-worksheet/${damageId}?token=${encodeURIComponent(getToken())}`, '_blank');
}
</script>

<template>
  <div class="page">
    <el-skeleton v-if="detailQuery.isLoading.value" :rows="6" animated />
    <el-alert v-else-if="!garment || !stats" type="error" :closable="false" title="衣物档案不存在或已删除" />

    <template v-else>
      <div class="page-header">
        <div>
          <h1 class="page-title">
            {{ garment.name }}
            <span class="muted mono" style="font-size: 13px">{{ garment.code }}</span>
          </h1>
          <div class="page-subtitle">
            {{ GARMENT_CATEGORY_LABEL[garment.category as GarmentCategory] }} ·
            {{ MATERIAL_PRIMARY_LABEL[garment.materialPrimary as MaterialPrimary] }}（{{ KNIT_OR_WOVEN_LABEL[garment.knitOrWoven as KnitOrWoven] }}）·
            {{ garment.seasonTags.map((s) => SEASON_LABEL[s as Season]).join('/') }} ·
            {{ GARMENT_STATUS_LABEL[garment.status as GarmentStatus] }}
            <span v-if="garment.retiredAt">
              · 已处置：{{ DISPOSITION_LABEL[garment.disposition as Disposition] ?? '—' }}
            </span>
          </div>
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap">
          <el-button size="small" :loading="busy" @click="wearToday">今天穿了</el-button>
          <el-button size="small" @click="markWashed">已清洗</el-button>
          <el-button size="small" @click="openPrint">打印档案</el-button>
          <el-button size="small" @click="exportMarkdown">导出 Markdown</el-button>
          <el-dropdown>
            <el-button size="small">
              更多<el-icon class="el-icon--right"><ArrowDown /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item @click="router.push({ name: 'annotate', params: { id: garmentId } })">编辑照片标记</el-dropdown-item>
                <el-dropdown-item @click="router.push({ name: 'damage-new', params: { id: garmentId } })">登记新破损</el-dropdown-item>
                <el-dropdown-item v-if="garment.status === 'retired'" @click="restore">恢复为在用</el-dropdown-item>
                <el-dropdown-item v-else @click="retireDialog = true">登记退役</el-dropdown-item>
                <el-dropdown-item divided @click="removeGarment">删除档案</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </div>

      <el-alert
        v-if="detail!.orphanAnnotationCount > 0"
        type="warning"
        :closable="false"
        style="margin-bottom: 12px"
        :title="`有 ${detail!.orphanAnnotationCount} 个标记还没关联到破损事件`"
        description="标记只记了位置；关联破损事件后才会进入修补与复检的闭环。"
      />

      <el-row :gutter="12">
        <el-col :xs="24" :md="15">
          <el-card shadow="never">
            <template #header>照片与标记</template>
            <EmptyState v-if="photos.length === 0" title="还没有照片" description="至少拍正面、背面、洗标，之后才好在图上标位置。">
              <PhotoUploader :garment-id="garmentId" @uploaded="refresh" />
            </EmptyState>
            <div v-else>
              <div style="display: flex; gap: 12px; flex-wrap: wrap">
                <div v-for="photo in photos" :key="photo.id" style="width: 200px">
                  <img
                    :src="photoUrl(photo.id)"
                    style="width: 100%; border-radius: 6px; cursor: pointer"
                    :alt="photo.view"
                    @click="router.push({ name: 'annotate', params: { id: garmentId }, query: { photoId: photo.id } })"
                  />
                  <div class="muted">
                    {{ PHOTO_VIEW_LABEL[photo.view as PhotoView] }} · {{ photo.annotations?.length ?? 0 }} 个标记
                  </div>
                </div>
              </div>
              <div class="card-actions">
                <el-button type="primary" size="small" @click="router.push({ name: 'annotate', params: { id: garmentId } })">
                  打开标记编辑器
                </el-button>
              </div>
              <el-divider />
              <PhotoUploader :garment-id="garmentId" default-view="detail" @uploaded="refresh" />
            </div>
          </el-card>

          <el-card shadow="never">
            <template #header>
              <div style="display: flex; justify-content: space-between; align-items: center">
                <span>破损与修补史（{{ damages.length }}）</span>
                <el-button type="primary" size="small" @click="router.push({ name: 'damage-new', params: { id: garmentId } })">
                  登记破损
                </el-button>
              </div>
            </template>
            <EmptyState v-if="damages.length === 0" title="还没有破损记录" description="破了记得回来登记一次，位置、针法、用料都记下来。" />
            <div v-else style="display: grid; gap: 12px">
              <el-card v-for="damage in damages" :key="damage.id" shadow="hover" body-style="padding: 12px">
                <div style="display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap">
                  <div>
                    <div style="font-weight: 600">
                      {{ damage.damageType.name }} · {{ SEVERITY_LABEL[damage.severity as Severity] }}
                      <el-tag v-if="damage.recurrenceOf" size="small" type="warning" style="margin-left: 6px">
                        复发第 {{ damage.recurrenceIndex }} 次
                      </el-tag>
                    </div>
                    <div class="muted">
                      <span class="mono">{{ damage.code }}</span> · {{ damage.detectedAt.slice(0, 10) }} ·
                      {{ damage.part?.name ?? (damage.locationUnknown ? '位置不便标记' : '未标部位') }} ·
                      {{ DAMAGE_STATUS_LABEL[damage.status as DamageStatus] }}
                    </div>
                  </div>
                  <div style="display: flex; gap: 6px">
                    <el-button size="small" @click="router.push({ name: 'damage-detail', params: { id: damage.id } })">详情</el-button>
                    <el-button size="small" @click="openWorksheet(damage.id)">工单</el-button>
                  </div>
                </div>

                <el-table v-if="damage.repairs.length" :data="damage.repairs" size="small" style="margin-top: 8px">
                  <el-table-column label="轮次" width="70">
                    <template #default="{ row }">第 {{ row.round }} 轮</template>
                  </el-table-column>
                  <el-table-column label="针法" width="120">
                    <template #default="{ row }">{{ row.stitch.name }}</template>
                  </el-table-column>
                  <el-table-column label="完成" width="110">
                    <template #default="{ row }">{{ row.finishedAt.slice(0, 10) }}</template>
                  </el-table-column>
                  <el-table-column label="状态" width="110">
                    <template #default="{ row }">{{ REPAIR_STATUS_LABEL[row.status as RepairStatus] }}</template>
                  </el-table-column>
                  <el-table-column label="修补后变化">
                    <template #default="{ row }">
                      <span v-if="row.change">
                        痕迹 {{ row.change.visibility }} / 颜色 {{ row.change.colorMatch }} / 手感 {{ row.change.stiffness }}
                      </span>
                      <el-tag v-else size="small" type="warning">未填写</el-tag>
                    </template>
                  </el-table-column>
                  <el-table-column label="复检" width="160">
                    <template #default="{ row }">
                      <span v-if="lastReview(row.reviews)">
                        {{ VERDICT_LABEL[lastReview(row.reviews)!.verdict as Verdict] }} ·
                        {{ lastReview(row.reviews)!.reviewedAt.slice(5, 10) }}
                      </span>
                      <el-button v-else size="small" type="primary" link @click="router.push({ name: 'review', params: { id: row.id } })">
                        去复检
                      </el-button>
                    </template>
                  </el-table-column>
                  <el-table-column width="80">
                    <template #default="{ row }">
                      <el-button link @click="router.push({ name: 'repair-detail', params: { id: row.id } })">查看</el-button>
                    </template>
                  </el-table-column>
                </el-table>

                <div v-if="openDamageIds.has(damage.id)" class="card-actions">
                  <el-button size="small" type="primary" @click="router.push({ name: 'repair-new', params: { id: damage.id } })">
                    登记修补
                  </el-button>
                  <el-button size="small" @click="router.push({ name: 'damage-detail', params: { id: damage.id } })">
                    排期 / 取消
                  </el-button>
                </div>
              </el-card>
            </div>
          </el-card>
        </el-col>

        <el-col :xs="24" :md="9">
          <HealthScoreCard :health="detail!.health" />

          <el-card shadow="never">
            <template #header>长期使用</template>
            <el-descriptions :column="1" size="small" border>
              <el-descriptions-item label="穿着次数">
                {{ stats.wearCount }} 次（近 30 天 {{ stats.wearCountLast30 }} 次）
              </el-descriptions-item>
              <el-descriptions-item label="月均频率">
                {{ stats.perMonth }} 次/月 · {{ WEAR_FREQUENCY_BAND_LABEL[stats.frequencyBand] }}
              </el-descriptions-item>
              <el-descriptions-item label="服役天数">{{ stats.serviceDays }} 天</el-descriptions-item>
              <el-descriptions-item label="修补次数">{{ stats.repairCount }} 次</el-descriptions-item>
              <el-descriptions-item label="复修率">
                {{ (stats.recurrenceRate * 100).toFixed(0) }}%（复发 {{ stats.recurrenceCount }} / 已修补 {{ stats.repairedEventCount }}）
              </el-descriptions-item>
              <el-descriptions-item label="每穿成本">{{ stats.costPerWear ?? '—' }} 元</el-descriptions-item>
              <el-descriptions-item label="累计成本">
                {{ (stats.purchasePrice + stats.totalRepairCost).toFixed(2) }} 元
              </el-descriptions-item>
              <el-descriptions-item label="清洗计数">
                {{ garment.wearsSinceWash }} 次未洗
                <span v-if="detail!.careRule">（建议 {{ detail!.careRule.wearCountBeforeWash }} 次一洗）</span>
              </el-descriptions-item>
              <el-descriptions-item label="收纳">{{ garment.storageLocation ?? '—' }}</el-descriptions-item>
              <el-descriptions-item label="洗护原文">{{ garment.careNote ?? '—' }}</el-descriptions-item>
            </el-descriptions>
          </el-card>

          <el-card v-if="detail!.material" shadow="never">
            <template #header>这个材质要留意</template>
            <div class="muted">耐久分 {{ detail!.material.durabilityScore }}/5</div>
            <div style="margin-top: 6px">清洗：{{ detail!.material.washAdvice }}</div>
            <div>晾晒：{{ detail!.material.dryAdvice }}</div>
            <div>典型薄弱部位：{{ detail!.material.typicalWeakPoints.join('、') || '—' }}</div>
          </el-card>

          <el-card v-if="detail!.suggestedStitches.length" shadow="never">
            <template #header>适合这件衣物的针法</template>
            <div v-for="stitch in detail!.suggestedStitches" :key="stitch.id" style="margin-bottom: 8px">
              <div style="font-weight: 600">
                {{ stitch.name }}<span class="muted"> · 约 {{ stitch.typicalMinutes }} 分钟</span>
              </div>
              <div class="muted">{{ stitch.description }}</div>
            </div>
          </el-card>

          <el-card shadow="never">
            <template #header>时间线</template>
            <el-timeline v-if="(timelineQuery.data.value?.events.length ?? 0) > 0">
              <el-timeline-item
                v-for="event in timelineQuery.data.value?.events.slice(0, 25)"
                :key="`${event.type}-${event.refId}`"
                :timestamp="String(event.at).slice(0, 10)"
                :type="event.type === 'damage' ? 'danger' : event.type === 'repair' ? 'primary' : event.type === 'review' ? 'success' : 'info'"
              >
                <div>{{ event.title }}</div>
                <div class="muted">{{ event.detail }}</div>
              </el-timeline-item>
            </el-timeline>
            <EmptyState v-else title="还没有记录" />
          </el-card>
        </el-col>
      </el-row>

      <el-dialog v-model="retireDialog" title="登记退役" width="460px">
        <el-form label-width="90px">
          <el-form-item label="处置方式" required>
            <el-select v-model="retireForm.disposition" style="width: 100%">
              <el-option v-for="item in DISPOSITIONS" :key="item" :value="item" :label="DISPOSITION_LABEL[item]" />
            </el-select>
          </el-form-item>
          <el-form-item label="说明">
            <el-input v-model="retireForm.dispositionNote" type="textarea" :rows="2" placeholder="例如：拆线改成手套" />
          </el-form-item>
        </el-form>
        <div class="muted">退役后，所有未处理的破损提醒会自动失效，不会留下无法处理的待办。</div>
        <template #footer>
          <el-button @click="retireDialog = false">取消</el-button>
          <el-button type="primary" :loading="busy" @click="retire">确认退役</el-button>
        </template>
      </el-dialog>
    </template>
  </div>
</template>
