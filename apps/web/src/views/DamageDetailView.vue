<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  CAUSE_GUESSES,
  CAUSE_GUESS_LABEL,
  DAMAGE_STATUS_LABEL,
  DAMAGE_TERMINAL_STATUSES,
  DETECTED_SOURCE_LABEL,
  REPAIR_STATUS_LABEL,
  SEVERITIES,
  SEVERITY_LABEL,
  VERDICT_LABEL,
  type CauseGuess,
  type DamageStatus,
  type DetectedSource,
  type RepairStatus,
  type Severity,
  type Verdict,
} from '@gml/shared';
import { damageApi, wardrobeApi } from '../api';
import { getToken, messageOf, photoFileUrl } from '../api/client';
import EmptyState from '../components/EmptyState.vue';
import PartPicker from '../components/PartPicker.vue';
import { useVersionedUpdate } from '../composables/useVersionedUpdate';
import type { DamageDetail, DictionaryResponse } from '../types';

const route = useRoute();
const router = useRouter();
const damageId = String(route.params.id);
const data = ref<DamageDetail | null>(null);
const candidates = ref<Array<{ id: string; code: string; detectedAt: string; damageType: string; part: string | null; lastStitch: string | null; daysSince: number }>>([]);
const busy = ref(false);
const scheduleDate = ref('');
const dict = ref<DictionaryResponse | null>(null);
const editOpen = ref(false);
const editBusy = ref(false);
const editBaseVersion = ref(1);
const editForm = ref({
  damageTypeId: '',
  severity: 'moderate' as Severity,
  partId: null as string | null,
  detectedAt: '',
  description: '',
  causeGuess: null as CauseGuess | null,
  lengthMm: undefined as number | undefined,
  widthMm: undefined as number | undefined,
});
const { save: saveVersioned } = useVersionedUpdate();

const damage = computed(() => data.value?.damage);
const isOpen = computed(() => !!damage.value && !DAMAGE_TERMINAL_STATUSES.includes(damage.value.status as DamageStatus));

async function load(): Promise<void> {
  try {
    data.value = await damageApi.detail(damageId);
    if (isOpen.value) {
      candidates.value = (await damageApi.recurrenceCandidates(damageId)).candidates;
    }
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

onMounted(load);

async function linkRecurrence(recurrenceOfId: string): Promise<void> {
  busy.value = true;
  try {
    await damageApi.linkRecurrence(damageId, recurrenceOfId);
    ElMessage.success('已建立复发关系，复发预警提醒已生成');
    await load();
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    busy.value = false;
  }
}

async function schedule(): Promise<void> {
  if (!scheduleDate.value) {
    ElMessage.warning('请选择计划修补日期');
    return;
  }
  try {
    await damageApi.schedule(damageId, scheduleDate.value);
    ElMessage.success('已排期，到那天会提醒你');
    await load();
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

async function cancel(): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('请说明取消原因（例如其实不是破损）', '取消这次破损记录', {
      inputPlaceholder: '原因',
    });
    await damageApi.cancel(damageId, value);
    ElMessage.success('已取消');
    await load();
  } catch (error) {
    if (error instanceof Error) ElMessage.error(messageOf(error));
  }
}

async function markUnrepairable(): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('说明为什么修不了（会影响退役建议）', '判定不可修', {
      inputPlaceholder: '例如：面料已经脆化，缝不住',
    });
    await damageApi.markUnrepairable(damageId, value);
    ElMessage.success('已标记为不可修');
    await load();
  } catch (error) {
    if (error instanceof Error) ElMessage.error(messageOf(error));
  }
}

function openWorksheet(): void {
  window.open(`/api/print/repair-worksheet/${damageId}?token=${encodeURIComponent(getToken())}`, '_blank');
}

/** 打开编辑对话框：记下打开时的记录版本，保存时按它做乐观锁合并 */
async function openEdit(): Promise<void> {
  if (!damage.value) return;
  try {
    dict.value = dict.value ?? (await wardrobeApi.dictionary());
  } catch (error) {
    ElMessage.error(messageOf(error));
    return;
  }
  editForm.value = {
    damageTypeId: damage.value.damageType.id,
    severity: damage.value.severity as Severity,
    partId: damage.value.part?.id ?? null,
    detectedAt: damage.value.detectedAt.slice(0, 10),
    description: damage.value.description ?? '',
    causeGuess: (damage.value.causeGuess as CauseGuess | null) ?? null,
    lengthMm: damage.value.measurableSize?.lengthMm,
    widthMm: damage.value.measurableSize?.widthMm,
  };
  editBaseVersion.value = damage.value.version;
  editOpen.value = true;
}

async function saveEdit(): Promise<void> {
  editBusy.value = true;
  try {
    const changes = {
      damageTypeId: editForm.value.damageTypeId,
      severity: editForm.value.severity,
      partId: editForm.value.partId,
      detectedAt: editForm.value.detectedAt,
      description: editForm.value.description || null,
      causeGuess: editForm.value.causeGuess,
      measurableSize:
        editForm.value.lengthMm !== undefined || editForm.value.widthMm !== undefined
          ? { lengthMm: editForm.value.lengthMm ?? 0, widthMm: editForm.value.widthMm ?? 0 }
          : null,
    };
    const outcome = await saveVersioned(
      'damage-update',
      damageId,
      changes,
      editBaseVersion.value,
      `破损编辑 · ${damage.value?.code ?? ''}`,
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
    <el-skeleton v-if="!damage" :rows="5" animated />

    <template v-else>
      <div class="page-header">
        <div>
          <h1 class="page-title">
            {{ damage.damageType.name }} · {{ SEVERITY_LABEL[damage.severity as Severity] }}
            <span class="muted mono" style="font-size: 13px">{{ damage.code }}</span>
          </h1>
          <div class="page-subtitle">
            {{ damage.garment.name }} · {{ damage.part?.name ?? '未标部位' }} ·
            发现于 {{ damage.detectedAt.slice(0, 10) }} ·
            {{ DAMAGE_STATUS_LABEL[damage.status as DamageStatus] }}
          </div>
        </div>
        <div style="display: flex; gap: 8px">
          <el-button size="small" @click="openWorksheet">打印修补工单</el-button>
          <el-button size="small" :disabled="!isOpen" @click="openEdit">编辑</el-button>
          <el-button size="small" type="primary" :disabled="!isOpen" @click="router.push({ name: 'repair-new', params: { id: damageId } })">
            登记修补
          </el-button>
        </div>
      </div>

      <el-row :gutter="12">
        <el-col :xs="24" :md="16">
          <el-card shadow="never">
            <template #header>证据照片与标记</template>
            <div v-if="damage.annotations && damage.annotations.length" style="display: flex; gap: 12px; flex-wrap: wrap">
              <div v-for="annotation in damage.annotations" :key="annotation.id" style="width: 240px">
                <img
                  :src="photoFileUrl(annotation.photoId)"
                  style="width: 100%; border-radius: 6px"
                  alt="破损位置"
                />
                <div class="muted">
                  {{ damage.part?.name ?? '未标部位' }} ·
                  <span class="mono">
                    x={{ Number(annotation.geometry.x ?? 0).toFixed(3) }} y={{ Number(annotation.geometry.y ?? 0).toFixed(3) }}
                  </span>
                </div>
              </div>
            </div>
            <EmptyState
              v-else
              :title="damage.locationUnknown ? '登记时说明位置不便标记' : '没有关联照片标记'"
              :description="damage.locationNote ?? '建议在档案页补一张照片并标出位置，复发识别会更准。'"
            />
          </el-card>

          <el-card shadow="never">
            <template #header>修补轮次（{{ damage.repairs.length }}）</template>
            <EmptyState v-if="damage.repairs.length === 0" title="还没有修补记录">
              <el-button type="primary" :disabled="!isOpen" @click="router.push({ name: 'repair-new', params: { id: damageId } })">
                现在登记一次修补
              </el-button>
            </EmptyState>
            <el-timeline v-else>
              <el-timeline-item
                v-for="repair in damage.repairs"
                :key="repair.id"
                :timestamp="`${repair.finishedAt.slice(0, 10)}（第 ${repair.round} 轮）`"
                :type="repair.status === 'passed' ? 'success' : repair.status === 'failed' ? 'danger' : 'primary'"
              >
                <div style="display: flex; justify-content: space-between; gap: 8px">
                  <div>
                    <div style="font-weight: 600">{{ repair.stitch.name }} · {{ REPAIR_STATUS_LABEL[repair.status as RepairStatus] }}</div>
                    <div class="muted">
                      观察期 {{ repair.observationDays }} 天（至 {{ repair.observationUntil.slice(0, 10) }}）
                      <span v-if="repair.materials.length">
                        · 用料：{{ repair.materials.map((m) => `${m.fabricSource.name} ${m.amount}${m.unit}`).join('、') }}
                      </span>
                    </div>
                    <div v-if="repair.change" class="muted">
                      修补后变化：痕迹 {{ repair.change.visibility }} / 颜色 {{ repair.change.colorMatch }} / 手感 {{ repair.change.stiffness }}
                      <span v-if="repair.change.comfortNote"> · {{ repair.change.comfortNote }}</span>
                    </div>
                    <div v-else class="muted" style="color: #e6a23c">修补后变化未填写</div>
                    <div v-if="repair.reviews.length" class="muted">
                      复检：{{ repair.reviews.map((r) => `${VERDICT_LABEL[r.verdict as Verdict]}（${r.daysSinceRepair} 天）`).join('、') }}
                    </div>
                  </div>
                  <el-button size="small" @click="router.push({ name: 'repair-detail', params: { id: repair.id } })">查看</el-button>
                </div>
              </el-timeline-item>
            </el-timeline>
          </el-card>
        </el-col>

        <el-col :xs="24" :md="8">
          <el-card shadow="never">
            <template #header>事件信息</template>
            <el-descriptions :column="1" size="small" border>
              <el-descriptions-item label="描述">{{ damage.description ?? '—' }}</el-descriptions-item>
              <el-descriptions-item label="原因猜测">
                {{ damage.causeGuess ? CAUSE_GUESS_LABEL[damage.causeGuess as CauseGuess] : '—' }}
              </el-descriptions-item>
              <el-descriptions-item label="实测尺寸">
                {{ damage.measurableSize ? `${damage.measurableSize.lengthMm} × ${damage.measurableSize.widthMm} mm` : '—' }}
              </el-descriptions-item>
              <el-descriptions-item label="发现方式">
                {{ DETECTED_SOURCE_LABEL[damage.detectedSource as DetectedSource] ?? damage.detectedSource }}
              </el-descriptions-item>
              <el-descriptions-item label="计划修补">{{ damage.scheduledAt?.slice(0, 10) ?? '—' }}</el-descriptions-item>
              <el-descriptions-item label="复发情况">
                <span v-if="damage.recurrenceOf">
                  第 {{ damage.recurrenceIndex }} 次（原始事件 {{ damage.original?.code }}）
                </span>
                <span v-else>首次发生</span>
              </el-descriptions-item>
            </el-descriptions>
          </el-card>

          <el-card v-if="candidates.length" shadow="never">
            <template #header>这是复发吗？</template>
            <div class="muted" style="margin-bottom: 8px">
              系统按「同一件衣物 + 同一部位 + 同类型」匹配到历史记录，确认后会串成复发链，并计入复修率。
            </div>
            <div v-for="candidate in candidates" :key="candidate.id" style="border-bottom: 1px solid #f2f3f5; padding: 8px 0">
              <div style="font-weight: 600">
                {{ candidate.code }} · {{ candidate.damageType }}
                <span class="muted">{{ candidate.part }}</span>
              </div>
              <div class="muted">
                {{ candidate.detectedAt.slice(0, 10) }}（{{ candidate.daysSince }} 天前）
                <span v-if="candidate.lastStitch"> · 上次用「{{ candidate.lastStitch }}」</span>
              </div>
              <el-button size="small" type="primary" :loading="busy" style="margin-top: 4px" @click="linkRecurrence(candidate.id)">
                确认是复发
              </el-button>
            </div>
          </el-card>

          <el-card v-if="isOpen" shadow="never">
            <template #header>后续处理</template>
            <div style="display: grid; gap: 8px">
              <div>
                <el-date-picker v-model="scheduleDate" type="date" value-format="YYYY-MM-DD" placeholder="计划修补日期" style="width: 100%" />
                <el-button size="small" style="margin-top: 6px" @click="schedule">设为排期</el-button>
              </div>
              <el-divider />
              <el-button size="small" @click="markUnrepairable">判定为不可修</el-button>
              <el-button size="small" type="danger" plain @click="cancel">取消这条记录</el-button>
              <div class="muted">不可修或取消后，事件进入终态，并会清掉相关待办提醒。</div>
            </div>
          </el-card>
        </el-col>
      </el-row>

      <el-dialog v-model="editOpen" title="编辑破损记录" width="520px">
        <el-alert
          type="info"
          :closable="false"
          style="margin-bottom: 12px"
          :title="`基于版本 ${editBaseVersion} 编辑；保存时若记录已被其他设备修改，会提示你对比合并`"
        />
        <el-form label-width="100px">
          <el-form-item label="破损类型" required>
            <el-select v-model="editForm.damageTypeId" style="width: 220px">
              <el-option v-for="item in dict?.damageTypes ?? []" :key="item.id" :value="item.id" :label="item.name" />
            </el-select>
          </el-form-item>
          <el-form-item label="严重度" required>
            <el-radio-group v-model="editForm.severity">
              <el-radio-button v-for="item in SEVERITIES" :key="item" :label="item">{{ SEVERITY_LABEL[item] }}</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="部位">
            <PartPicker v-if="dict" v-model="editForm.partId" :parts="dict.partsFlat" />
          </el-form-item>
          <el-form-item label="发现日期" required>
            <el-date-picker v-model="editForm.detectedAt" type="date" value-format="YYYY-MM-DD" style="width: 180px" />
          </el-form-item>
          <el-form-item label="描述">
            <el-input v-model="editForm.description" type="textarea" :rows="3" maxlength="1000" />
          </el-form-item>
          <el-form-item label="原因猜测">
            <el-select v-model="editForm.causeGuess" clearable style="width: 220px">
              <el-option v-for="item in CAUSE_GUESSES" :key="item" :value="item" :label="CAUSE_GUESS_LABEL[item]" />
            </el-select>
          </el-form-item>
          <el-form-item label="实测尺寸">
            <el-input-number v-model="editForm.lengthMm" :min="0" :max="5000" placeholder="长(mm)" style="width: 140px" />
            <span style="margin: 0 6px">×</span>
            <el-input-number v-model="editForm.widthMm" :min="0" :max="5000" placeholder="宽(mm)" style="width: 140px" />
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
