<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import {
  CAUSE_GUESSES,
  CAUSE_GUESS_LABEL,
  DETECTED_SOURCE_LABEL,
  DETECTED_SOURCES,
  SEVERITIES,
  SEVERITY_LABEL,
  type CauseGuess,
  type DetectedSource,
  type Severity,
} from '@gml/shared';
import { damageApi, garmentApi, photoApi, wardrobeApi } from '../api';
import { ApiError, messageOf } from '../api/client';
import { useOfflineQueueStore } from '../stores/offlineQueue';
import PartPicker from '../components/PartPicker.vue';
import PhotoAnnotator, { type DraftAnnotation } from '../components/PhotoAnnotator.vue';
import type { DictionaryResponse, GarmentDetailResponse, PhotoAnnotationRow } from '../types';

const route = useRoute();
const router = useRouter();
const queryClient = useQueryClient();
const offline = useOfflineQueueStore();
const garmentId = String(route.params.id);

const step = ref(0);
const busy = ref(false);
const detail = ref<GarmentDetailResponse | null>(null);
const dict = ref<DictionaryResponse | null>(null);
const photoId = ref('');
const annotations = ref<PhotoAnnotationRow[]>([]);
const drafts = ref<DraftAnnotation[]>([]);
const tool = ref<'point' | 'rect'>('point');
const selectedId = ref<string | null>(null);
const annotatorRef = ref<InstanceType<typeof PhotoAnnotator> | null>(null);
const savedAnnotationIds = ref<string[]>([]);

const form = ref({
  damageTypeId: '',
  severity: 'moderate' as Severity,
  partId: null as string | null,
  detectedAt: new Date().toISOString().slice(0, 10),
  detectedSource: 'self' as DetectedSource,
  description: '',
  causeGuess: null as CauseGuess | null,
  lengthMm: undefined as number | undefined,
  widthMm: undefined as number | undefined,
  scheduledAt: '',
  locationUnknown: false,
  locationNote: '',
});

const photo = computed(() => detail.value?.photos.find((p) => p.id === photoId.value) ?? null);
const partName = computed(() => dict.value?.partsFlat.find((p) => p.id === form.value.partId)?.name ?? '');
const openDamages = computed(() =>
  (detail.value?.damages ?? []).filter((d) => ['pending', 'scheduled', 'in_repair', 'repaired', 'observing'].includes(d.status)),
);

onMounted(async () => {
  try {
    const [garment, dictData] = await Promise.all([garmentApi.detail(garmentId), wardrobeApi.dictionary()]);
    detail.value = garment;
    dict.value = dictData;
    photoId.value = garment.photos[0]?.id ?? '';
    form.value.damageTypeId = dictData.damageTypes[0]?.id ?? '';
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
});

async function loadAnnotations(): Promise<void> {
  if (!photoId.value) {
    annotations.value = [];
    return;
  }
  annotations.value = (await photoApi.annotations(photoId.value)).annotations;
}

function createDraft(payload: { kind: DraftAnnotation['kind']; geometry: DraftAnnotation['geometry'] }): void {
  drafts.value.push({
    localId: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    kind: payload.kind,
    geometry: payload.geometry,
    partId: form.value.partId,
    label: '',
    color: '#e8590c',
  });
}

function updateGeometry(payload: { source: 'saved' | 'draft'; id: string; geometry: DraftAnnotation['geometry'] }): void {
  if (payload.source === 'draft') {
    const draft = drafts.value.find((d) => d.localId === payload.id);
    if (draft) draft.geometry = payload.geometry;
    return;
  }
  const annotation = annotations.value.find((a) => a.id === payload.id);
  if (!annotation) return;
  annotation.geometry = payload.geometry as PhotoAnnotationRow['geometry'];
}

/** 松手才落库（拖动过程只更新本地预览） */
async function commitGeometry(payload: { id: string }): Promise<void> {
  const annotation = annotations.value.find((a) => a.id === payload.id);
  if (!annotation) return;
  try {
    await photoApi.updateAnnotation(annotation.id, { kind: annotation.kind, geometry: annotation.geometry });
  } catch {
    await loadAnnotations();
  }
}

/** 把当前表单组装成离线队列负载（标记 ID 可能为空——离线时标注没传上去，用文字说明兜底） */
function buildOfflinePayload(): Record<string, unknown> {
  return {
    garmentId,
    damageTypeId: form.value.damageTypeId,
    severity: form.value.severity,
    partId: form.value.partId,
    detectedAt: form.value.detectedAt,
    detectedSource: form.value.detectedSource,
    description: form.value.description || null,
    causeGuess: form.value.causeGuess,
    measurableSize:
      form.value.lengthMm !== undefined || form.value.widthMm !== undefined
        ? { lengthMm: form.value.lengthMm ?? 0, widthMm: form.value.widthMm ?? 0 }
        : null,
    annotationIds: savedAnnotationIds.value,
    locationUnknown: form.value.locationUnknown,
    locationNote: form.value.locationNote || null,
    scheduledAt: form.value.scheduledAt || null,
  };
}

function enqueueDamageAndLeave(): void {
  const payload = buildOfflinePayload();
  const damageTypeName = dict.value?.damageTypes.find((d) => d.id === form.value.damageTypeId)?.name ?? '破损';
  offline.enqueue({
    kind: 'damage-create',
    payload,
    summary: `${detail.value?.garment.name ?? '衣物'} · ${damageTypeName}（${form.value.detectedAt}）`,
  });
  ElMessage.warning('当前处于离线状态，破损登记已保存在本机，联网后会自动同步');
  void queryClient.invalidateQueries({ queryKey: ['garment'] });
  void router.push({ name: 'garment-detail', params: { id: garmentId } });
}

async function submit(): Promise<void> {
  if (!form.value.locationUnknown && savedAnnotationIds.value.length === 0 && drafts.value.length === 0) {
    ElMessage.warning('请在照片上标出破损位置，或勾选「位置不便标记」并说明原因');
    return;
  }
  if (form.value.locationUnknown && !form.value.locationNote.trim()) {
    ElMessage.warning('选择「位置不便标记」时必须写明原因');
    return;
  }
  busy.value = true;
  try {
    if (drafts.value.length > 0 && photoId.value) {
      try {
        const result = await photoApi.createAnnotations(
          photoId.value,
          drafts.value.map((draft) => ({
            kind: draft.kind,
            geometry: draft.geometry,
            partId: form.value.partId,
            label: null,
          })),
        );
        savedAnnotationIds.value.push(...result.annotations.map((a) => a.id));
        drafts.value = [];
      } catch (error) {
        // 断网时标注传不上去：没有标记的破损不允许入库。
        // 若用户已说明"位置不便标记"可以照常离线登记；否则引导他补一句文字说明，
        // 而不是收下一条同步时必然被服务端拒绝的僵尸记录。
        if (error instanceof ApiError && error.code === 'OFFLINE') {
          if (!form.value.locationUnknown) {
            ElMessage.warning('离线状态下无法上传照片标记，请勾选「位置不便标记」并用文字描述位置后再提交');
            step.value = 1;
            return;
          }
        } else {
          throw error;
        }
      }
    }

    try {
      const data = await damageApi.create(buildOfflinePayload());
      ElMessage.success(`已登记 ${data.damage.code}`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['garment'] }),
        queryClient.invalidateQueries({ queryKey: ['garments'] }),
        queryClient.invalidateQueries({ queryKey: ['wardrobe'] }),
      ]);
      await router.push({ name: 'damage-detail', params: { id: data.damage.id } });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'OFFLINE') {
        enqueueDamageAndLeave();
        return;
      }
      ElMessage.error(messageOf(error));
    }
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
        <h1 class="page-title">登记破损</h1>
        <div class="page-subtitle">位置是这一步的重点：标在照片上，之后才知道"是不是同一个地方又坏了"</div>
      </div>
      <el-button link @click="router.back()">返回</el-button>
    </div>

    <el-steps :active="step" finish-status="success" style="margin-bottom: 16px">
      <el-step title="类型与严重度" />
      <el-step title="标位置" />
      <el-step title="描述与计划" />
    </el-steps>

    <el-card v-if="step === 0" shadow="never">
      <el-form label-width="110px">
        <el-form-item label="破损类型" required>
          <el-select v-model="form.damageTypeId" style="width: 240px">
            <el-option v-for="item in dict?.damageTypes ?? []" :key="item.id" :value="item.id" :label="item.name" />
          </el-select>
          <div class="field-hint">
            {{ dict?.damageTypes.find((d) => d.id === form.damageTypeId)?.suggestedStitchCodes.join(' / ') || '这类问题一般不需要缝补' }}
          </div>
        </el-form-item>
        <el-form-item label="严重度" required>
          <el-radio-group v-model="form.severity">
            <el-radio-button v-for="item in SEVERITIES" :key="item" :label="item">{{ SEVERITY_LABEL[item] }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="部位">
          <PartPicker v-if="dict" v-model="form.partId" :parts="dict.partsFlat" />
        </el-form-item>
        <el-form-item label="发现日期" required>
          <el-date-picker v-model="form.detectedAt" type="date" value-format="YYYY-MM-DD" style="width: 200px" />
        </el-form-item>
        <el-form-item label="谁发现的">
          <el-select v-model="form.detectedSource" style="width: 200px">
            <el-option v-for="item in DETECTED_SOURCES" :key="item" :value="item" :label="DETECTED_SOURCE_LABEL[item]" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="openDamages.length" label="是复发吗">
          <div>
            <div class="muted" style="margin-bottom: 6px">
              这件衣服还有 {{ openDamages.length }} 个未终结的破损事件。如果这次是同一个位置又坏了，先创建记录，之后在详情页里确认复发关系。
            </div>
            <div v-for="damage in openDamages.slice(0, 3)" :key="damage.id" class="muted">
              · {{ damage.code }} {{ damage.damageType.name }} {{ damage.part?.name ?? '' }}（{{ damage.detectedAt.slice(0, 10) }}）
            </div>
          </div>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="step = 1">下一步：标位置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card v-else-if="step === 1" shadow="never">
      <div v-if="photo" class="toolbar">
        <el-radio-group v-model="photoId" size="small" @change="loadAnnotations">
          <el-radio-button v-for="p in detail?.photos ?? []" :key="p.id" :label="p.id">{{ p.view }}</el-radio-button>
        </el-radio-group>
        <el-radio-group v-model="tool" size="small">
          <el-radio-button label="point">点位</el-radio-button>
          <el-radio-button label="rect">矩形</el-radio-button>
        </el-radio-group>
        <el-button size="small" @click="annotatorRef?.zoomIn()">放大</el-button>
        <el-button size="small" @click="annotatorRef?.zoomOut()">缩小</el-button>
      </div>
      <PhotoAnnotator
        v-if="photo"
        ref="annotatorRef"
        :photo="photo"
        :annotations="annotations"
        :drafts="drafts"
        :selected-id="selectedId"
        :tool="tool"
        :pending-part-name="partName"
        @create-draft="createDraft"
        @update-geometry="updateGeometry"
        @commit-geometry="commitGeometry"
        @select="(id) => (selectedId = id)"
        @notify="() => undefined"
      />
      <el-alert
        v-else
        type="info"
        :closable="false"
        title="这件衣物还没有照片"
        description="可以在下一步用文字说明位置；建议之后回档案页补照片和标记。"
        style="margin-bottom: 8px"
      />

      <el-checkbox v-model="form.locationUnknown" style="margin-top: 12px">位置不便标记（例如已经送去店里）</el-checkbox>
      <el-input
        v-if="form.locationUnknown"
        v-model="form.locationNote"
        placeholder="说明一下位置，例如：左袖口内侧，送修时被师傅带走了"
        style="margin-top: 6px"
      />

      <div class="card-actions">
        <el-button @click="step = 0">上一步</el-button>
        <el-button type="primary" @click="step = 2">下一步</el-button>
      </div>
    </el-card>

    <el-card v-else shadow="never">
      <el-form label-width="110px">
        <el-form-item label="描述">
          <el-input v-model="form.description" type="textarea" :rows="3" maxlength="1000" placeholder="写清楚：多大、什么形状、怎么发现的" />
        </el-form-item>
        <el-form-item label="原因猜测">
          <el-select v-model="form.causeGuess" clearable style="width: 220px">
            <el-option v-for="item in CAUSE_GUESSES" :key="item" :value="item" :label="CAUSE_GUESS_LABEL[item]" />
          </el-select>
        </el-form-item>
        <el-form-item label="实测尺寸">
          <el-input-number v-model="form.lengthMm" :min="0" :max="5000" placeholder="长(mm)" style="width: 150px" />
          <span style="margin: 0 6px">×</span>
          <el-input-number v-model="form.widthMm" :min="0" :max="5000" placeholder="宽(mm)" style="width: 150px" />
        </el-form-item>
        <el-form-item label="计划修补">
          <el-date-picker v-model="form.scheduledAt" type="date" value-format="YYYY-MM-DD" placeholder="不填则进入待修队列" style="width: 220px" />
          <div class="field-hint">填了日期，到那天系统会把这件事推回你眼前。</div>
        </el-form-item>
        <el-form-item>
          <el-button @click="step = 1">上一步</el-button>
          <el-button type="primary" :loading="busy" @click="submit">提交登记</el-button>
        </el-form-item>
      </el-form>
      <div class="muted">
        提交后会：标记冻结为证据（之后编辑档案也改不掉当时的记录）→ 衣物状态变「待修」→ 进入修补流程。
      </div>
    </el-card>
  </div>
</template>
