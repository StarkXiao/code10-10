<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import {
  DRAPE_CHANGE_LABEL,
  EXECUTED_BY_LABEL,
  REPAIR_STATUS_LABEL,
  RESULT_RATINGS,
  RESULT_RATING_LABEL,
  STIFFNESS_LABEL,
  VERDICT_LABEL,
  VISIBILITY_LABEL,
  COLOR_MATCH_LABEL,
  type DrapeChange,
  type ExecutedBy,
  type RepairStatus,
  type ResultRating,
  type Stiffness,
  type Verdict,
  type Visibility,
  type ColorMatch,
} from '@gml/shared';
import { repairApi, wardrobeApi } from '../api';
import { getToken, messageOf } from '../api/client';
import BeforeAfterSlider from '../components/BeforeAfterSlider.vue';
import EmptyState from '../components/EmptyState.vue';
import { useVersionedUpdate } from '../composables/useVersionedUpdate';
import type { DictionaryResponse, RepairDetail } from '../types';

const route = useRoute();
const router = useRouter();
const repairId = String(route.params.id);
const data = ref<RepairDetail | null>(null);
const comparison = ref<Record<string, unknown> | null>(null);
const busy = ref(false);
const extraDays = ref<number | undefined>();
const dict = ref<DictionaryResponse | null>(null);
const editOpen = ref(false);
const editBusy = ref(false);
const editBaseVersion = ref(1);
const editForm = ref({
  stitchId: '',
  threadType: '',
  threadColor: '',
  durationMinutes: undefined as number | undefined,
  cost: undefined as number | undefined,
  resultRating: null as ResultRating | null,
  observationDays: undefined as number | undefined,
  note: '',
});
const { save: saveVersioned } = useVersionedUpdate();

const repair = computed(() => data.value?.repair);
const change = computed(() => repair.value?.change ?? null);
const beforePhoto = computed(() => (comparison.value?.before as { id: string } | null) ?? null);
const afterPhoto = computed(() => (comparison.value?.after as { id: string } | null) ?? null);
const aspectMismatch = computed(() => Boolean(comparison.value?.aspectMismatch));
const comparisonHint = computed(() => (comparison.value?.hint as string | null) ?? null);

async function load(): Promise<void> {
  try {
    data.value = await repairApi.detail(repairId);
    comparison.value = await repairApi.comparison(repairId);
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

onMounted(load);

async function startObservation(): Promise<void> {
  busy.value = true;
  try {
    const result = await repairApi.startObservation(repairId, extraDays.value);
    ElMessage.success(`已进入观察期，${result.observationUntil.slice(0, 10)} 会提醒复检`);
    await load();
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    busy.value = false;
  }
}

function openWorksheet(): void {
  window.open(`/api/print/repair-worksheet/${repair.value?.damageEventId}?token=${encodeURIComponent(getToken())}`, '_blank');
}

/** 打开编辑对话框：记下打开时的记录版本，保存时按它做乐观锁合并 */
async function openEdit(): Promise<void> {
  if (!repair.value) return;
  try {
    dict.value = dict.value ?? (await wardrobeApi.dictionary());
  } catch (error) {
    ElMessage.error(messageOf(error));
    return;
  }
  editForm.value = {
    stitchId: repair.value.stitch.id,
    threadType: repair.value.threadType ?? '',
    threadColor: repair.value.threadColor ?? '',
    durationMinutes: repair.value.durationMinutes ?? undefined,
    cost: repair.value.cost !== null ? Number(repair.value.cost) : undefined,
    resultRating: (repair.value.resultRating as ResultRating | null) ?? null,
    observationDays: repair.value.observationDays,
    note: repair.value.note ?? '',
  };
  editBaseVersion.value = repair.value.version;
  editOpen.value = true;
}

async function saveEdit(): Promise<void> {
  editBusy.value = true;
  try {
    const changes = {
      stitchId: editForm.value.stitchId,
      threadType: editForm.value.threadType || null,
      threadColor: editForm.value.threadColor || null,
      durationMinutes: editForm.value.durationMinutes ?? null,
      cost: editForm.value.cost ?? null,
      resultRating: editForm.value.resultRating,
      observationDays: editForm.value.observationDays ?? null,
      note: editForm.value.note || null,
    };
    const outcome = await saveVersioned(
      'repair-update',
      repairId,
      changes,
      editBaseVersion.value,
      `修补编辑 · ${repair.value?.damageEvent.code ?? ''} 第 ${repair.value?.round ?? ''} 轮`,
    );
    if (outcome === 'failed') return;
    editOpen.value = false;
    // 离线入队/转冲突时本地没有新数据可刷新，只有真正落库才重新拉详情
    if (outcome === 'saved') await load();
  } finally {
    editBusy.value = false;
  }
}
</script>

<template>
  <div class="page">
    <el-skeleton v-if="!repair" :rows="5" animated />
    <template v-else>
      <div class="page-header">
        <div>
          <h1 class="page-title">
            第 {{ repair.round }} 轮修补 · {{ repair.stitch.name }}
            <el-tag size="small" style="margin-left: 8px">{{ REPAIR_STATUS_LABEL[repair.status as RepairStatus] }}</el-tag>
          </h1>
          <div class="page-subtitle">
            {{ repair.damageEvent.garment.name }} · {{ repair.damageEvent.code }} ·
            {{ repair.damageEvent.damageType.name }} ·
            {{ repair.damageEvent.part?.name ?? '未标部位' }}
          </div>
        </div>
        <div style="display: flex; gap: 8px">
          <el-button size="small" @click="openWorksheet">打印工单</el-button>
          <el-button size="small" @click="router.push({ name: 'damage-detail', params: { id: repair.damageEventId } })">破损详情</el-button>
          <el-button
            v-if="repair.status !== 'passed' && repair.status !== 'superseded'"
            size="small"
            @click="openEdit"
          >
            编辑
          </el-button>
          <el-button
            v-if="repair.status !== 'passed' && repair.status !== 'superseded'"
            size="small"
            type="primary"
            @click="router.push({ name: 'review', params: { id: repairId } })"
          >
            填写复检
          </el-button>
        </div>
      </div>

      <el-alert
        v-if="repair.status === 'done'"
        type="warning"
        :closable="false"
        style="margin-bottom: 12px"
        title="这次修补还没进入观察期"
        description="进入观察期后系统才会安排复检提醒；也可以直接在这里开始观察。"
      >
        <div style="margin-top: 8px; display: flex; gap: 8px; align-items: center">
          <el-input-number v-model="extraDays" :min="1" :max="365" :placeholder="`默认 ${repair.observationDays} 天`" style="width: 180px" />
          <el-button size="small" type="primary" :loading="busy" @click="startObservation">开始观察期</el-button>
        </div>
      </el-alert>

      <el-row :gutter="12">
        <el-col :xs="24" :md="14">
          <el-card shadow="never">
            <template #header>修补前后对比</template>
            <BeforeAfterSlider
              :before-photo-id="beforePhoto?.id ?? null"
              :after-photo-id="afterPhoto?.id ?? null"
              :aspect-mismatch="aspectMismatch"
              :hint="comparisonHint"
            />
          </el-card>

          <el-card shadow="never">
            <template #header>修补细节</template>
            <el-descriptions :column="2" size="small" border>
              <el-descriptions-item label="执行方">
                {{ EXECUTED_BY_LABEL[repair.executedBy as ExecutedBy] }}
                <span v-if="repair.shopName"> · {{ repair.shopName }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="线材">
                {{ repair.threadType ?? '—' }} {{ repair.threadColor ? `（${repair.threadColor}）` : '' }}
              </el-descriptions-item>
              <el-descriptions-item label="起止">
                {{ repair.startedAt.slice(0, 10) }} → {{ repair.finishedAt.slice(0, 10) }}
              </el-descriptions-item>
              <el-descriptions-item label="耗时 / 花费">
                {{ repair.durationMinutes ?? '—' }} 分钟 / {{ data!.totalCost }} 元
              </el-descriptions-item>
              <el-descriptions-item label="观察期">
                {{ repair.observationDays }} 天（至 {{ repair.observationUntil.slice(0, 10) }}）
              </el-descriptions-item>
              <el-descriptions-item label="满意度">
                {{ repair.resultRating ? RESULT_RATING_LABEL[repair.resultRating as ResultRating] : '—' }}
              </el-descriptions-item>
              <el-descriptions-item label="辅助针法" :span="2">
                {{ data!.secondaryStitches.map((s) => s.name).join('、') || '—' }}
              </el-descriptions-item>
              <el-descriptions-item label="备注" :span="2">{{ repair.note ?? '—' }}</el-descriptions-item>
            </el-descriptions>
          </el-card>

          <el-card shadow="never">
            <template #header>修补后变化</template>
            <EmptyState v-if="!change" title="还没有记录变化" description="这是档案最有价值的部分，别跳过。" />
            <el-descriptions v-else :column="2" size="small" border>
              <el-descriptions-item label="外观痕迹">{{ VISIBILITY_LABEL[change.visibility as Visibility] }}</el-descriptions-item>
              <el-descriptions-item label="颜色匹配">{{ COLOR_MATCH_LABEL[change.colorMatch as ColorMatch] }}</el-descriptions-item>
              <el-descriptions-item label="手感">{{ STIFFNESS_LABEL[change.stiffness as Stiffness] }}</el-descriptions-item>
              <el-descriptions-item label="垂坠感">{{ DRAPE_CHANGE_LABEL[change.drapeChange as DrapeChange] }}</el-descriptions-item>
              <el-descriptions-item label="尺寸变化">
                {{ change.dimensionChange ? `${change.dimensionChange.lengthMm} × ${change.dimensionChange.widthMm} mm` : '—' }}
              </el-descriptions-item>
              <el-descriptions-item label="影响">
                <span v-if="change.mobilityLimited">影响活动 </span>
                <span v-if="change.visibleFromOutside">外人看得出 </span>
                <span v-if="!change.mobilityLimited && !change.visibleFromOutside">无</span>
              </el-descriptions-item>
              <el-descriptions-item label="穿着体感" :span="2">{{ change.comfortNote ?? '—' }}</el-descriptions-item>
              <el-descriptions-item label="试穿记录" :span="2">{{ change.wearTestNote ?? '—' }}</el-descriptions-item>
            </el-descriptions>
          </el-card>
        </el-col>

        <el-col :xs="24" :md="10">
          <el-card shadow="never">
            <template #header>用料与库存流水</template>
            <EmptyState v-if="repair.materials.length === 0" title="没有记录用料" description="记了用料才能算清成本、也才知道哪块布最耐用。" />
            <div v-else>
              <div v-for="material in repair.materials" :key="material.id" style="border-bottom: 1px solid #f2f3f5; padding: 6px 0">
                <div style="font-weight: 600">{{ material.fabricSource.name }}</div>
                <div class="muted">
                  用量 {{ material.amount }}{{ material.unit }} · 剩余
                  {{ material.fabricSource.inventory?.remainingAmount ?? '—' }}{{ material.unit }}
                  <span v-if="material.note"> · {{ material.note }}</span>
                </div>
              </div>
            </div>
          </el-card>

          <el-card shadow="never">
            <template #header>复检记录（{{ repair.reviews.length }}）</template>
            <EmptyState v-if="repair.reviews.length === 0" title="还没有复检" :description="`观察期到 ${repair.observationUntil.slice(0, 10)}，届时会提醒你。`">
              <el-button size="small" type="primary" @click="router.push({ name: 'review', params: { id: repairId } })">现在就复检</el-button>
            </EmptyState>
            <div v-else>
              <div v-for="review in repair.reviews" :key="review.id" style="border-bottom: 1px solid #f2f3f5; padding: 8px 0">
                <el-tag :type="review.verdict === 'good' ? 'success' : review.verdict === 'fair' ? 'warning' : 'danger'" size="small">
                  {{ VERDICT_LABEL[review.verdict as Verdict] }}
                </el-tag>
                <span class="muted" style="margin-left: 6px">
                  {{ review.reviewedAt.slice(0, 10) }} · 修补后 {{ review.daysSinceRepair }} 天 · 穿着 {{ review.wornSince ?? 0 }} 次
                </span>
                <div v-if="review.verdictNote" class="muted">{{ review.verdictNote }}</div>
                <div class="muted">
                  下一步：{{ review.nextAction }}
                  <span v-if="review.reoccurred"> · 已复发</span>
                </div>
              </div>
            </div>
          </el-card>
        </el-col>
      </el-row>

      <el-dialog v-model="editOpen" title="编辑修补记录" width="520px">
        <el-alert
          type="info"
          :closable="false"
          style="margin-bottom: 12px"
          :title="`基于版本 ${editBaseVersion} 编辑；保存时若记录已被其他设备修改，会提示你对比合并`"
        />
        <el-form label-width="100px">
          <el-form-item label="针法" required>
            <el-select v-model="editForm.stitchId" style="width: 260px">
              <el-option v-for="item in dict?.stitches ?? []" :key="item.id" :value="item.id" :label="item.name" />
            </el-select>
          </el-form-item>
          <el-form-item label="线材 / 线色">
            <el-input v-model="editForm.threadType" placeholder="羊毛线" style="width: 180px" />
            <el-input v-model="editForm.threadColor" placeholder="深灰" style="width: 160px; margin-left: 8px" />
          </el-form-item>
          <el-form-item label="耗时 / 花费">
            <el-input-number v-model="editForm.durationMinutes" :min="0" :max="10000" placeholder="分钟" style="width: 140px" />
            <el-input-number v-model="editForm.cost" :min="0" :precision="2" placeholder="元" style="width: 150px; margin-left: 8px" />
          </el-form-item>
          <el-form-item label="满意度">
            <el-radio-group v-model="editForm.resultRating">
              <el-radio-button v-for="item in RESULT_RATINGS" :key="item" :label="item">{{ RESULT_RATING_LABEL[item] }}</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="观察期天数">
            <el-input-number v-model="editForm.observationDays" :min="1" :max="365" style="width: 160px" />
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="editForm.note" type="textarea" :rows="2" maxlength="1000" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="editOpen = false">取消</el-button>
          <el-button type="primary" :loading="editBusy" @click="saveEdit">保存</el-button>
        </template>
      </el-dialog>
    </template>
  </div>
</template>
