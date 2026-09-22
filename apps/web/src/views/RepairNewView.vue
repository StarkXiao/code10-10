<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import {
  COLOR_MATCHES,
  COLOR_MATCH_LABEL,
  DRAPE_CHANGE_LABEL,
  DRAPE_CHANGES,
  EXECUTED_BY,
  EXECUTED_BY_LABEL,
  FABRIC_KIND_LABEL,
  RESULT_RATING_LABEL,
  RESULT_RATINGS,
  STIFFNESS,
  STIFFNESS_LABEL,
  VISIBILITIES,
  VISIBILITY_LABEL,
  type ColorMatch,
  type DrapeChange,
  type ExecutedBy,
  type FabricKind,
  type ResultRating,
  type Stiffness,
  type Visibility,
} from '@gml/shared';
import { damageApi, fabricApi, photoApi, repairApi, wardrobeApi } from '../api';
import { ApiError, messageOf } from '../api/client';
import { useOfflineQueueStore } from '../stores/offlineQueue';
import PhotoUploader from '../components/PhotoUploader.vue';
import type { DamageDetail, DictionaryResponse, FabricSourceItem, GarmentPhotoRow } from '../types';

const route = useRoute();
const router = useRouter();
const queryClient = useQueryClient();
const offline = useOfflineQueueStore();
const damageId = String(route.params.id);

const step = ref(0);
const busy = ref(false);
const damage = ref<DamageDetail['damage'] | null>(null);
const dict = ref<DictionaryResponse | null>(null);
const fabricSources = ref<FabricSourceItem[]>([]);
const photos = ref<GarmentPhotoRow[]>([]);
const repairId = ref('');

const form = ref({
  executedBy: 'self' as ExecutedBy,
  shopName: '',
  shopCost: undefined as number | undefined,
  stitchId: '',
  secondaryIds: [] as string[],
  threadType: '',
  threadColor: '',
  durationMinutes: undefined as number | undefined,
  cost: undefined as number | undefined,
  startedAt: new Date().toISOString().slice(0, 10),
  finishedAt: new Date().toISOString().slice(0, 10),
  observationDays: undefined as number | undefined,
  reuseOriginalFabric: false,
  note: '',
  resultRating: 'satisfied' as ResultRating,
});

const materialForm = ref({ fabricSourceId: '', amount: 10, note: '' });
const change = ref({
  visibility: 'slight' as Visibility,
  colorMatch: 'close' as ColorMatch,
  stiffness: 'same' as Stiffness,
  drapeChange: 'none' as DrapeChange,
  comfortNote: '',
  mobilityLimited: false,
  visibleFromOutside: false,
  lengthMm: 0,
  widthMm: 0,
  photoBeforeId: null as string | null,
  photoAfterId: null as string | null,
  wearTestNote: '',
});

const isSelfRepair = computed(() => form.value.executedBy === 'self' || form.value.executedBy === 'family');
const suggested = computed(() => dict.value?.stitches ?? []);

onMounted(async () => {
  try {
    // 先拿破损详情（照片要按它所属的衣物去取；之前这里传了空 garmentId，会让整个 Promise.all 失败、页面拿不到数据）
    const [damageData, dictData, fabricData] = await Promise.all([
      damageApi.detail(damageId),
      wardrobeApi.dictionary(),
      fabricApi.list(),
    ]);
    damage.value = damageData.damage;
    dict.value = dictData;
    fabricSources.value = fabricData.items;
    photos.value = (await photoApi.list(damageData.damage.garmentId)).photos;
    form.value.stitchId = damageData.suggestedStitches[0]?.id ?? dictData.stitches[0]?.id ?? '';
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
});

function buildRepairPayload(): Record<string, unknown> {
  return {
    damageEventId: damageId,
    executedBy: form.value.executedBy,
    shopName: form.value.shopName || null,
    shopCost: form.value.shopCost ?? null,
    stitchId: form.value.stitchId,
    stitchSecondaryIds: form.value.secondaryIds,
    threadType: form.value.threadType || null,
    threadColor: form.value.threadColor || null,
    durationMinutes: form.value.durationMinutes ?? null,
    cost: form.value.cost ?? null,
    startedAt: form.value.startedAt,
    finishedAt: form.value.finishedAt,
    resultRating: form.value.resultRating,
    observationDays: form.value.observationDays ?? null,
    reuseOriginalFabric: form.value.reuseOriginalFabric,
    note: form.value.note || null,
  };
}

async function createRepair(): Promise<void> {
  if (!damage.value) return;
  busy.value = true;
  try {
    const data = await repairApi.create(buildRepairPayload());
    repairId.value = data.repair.id;
    ElMessage.success(`已登记第 ${data.repair.round} 轮修补`);
    step.value = 1;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'OFFLINE') {
      // 离线：第 1 轮修补先入队；记录本地破损版本，同步时若别的端已改过会回报冲突。
      // 多轮修补（返工）离线时无法知道自己是第几轮，提示用户联网后再登记，避免抢错轮次。
      const hasRepairs = (damage.value.repairs?.length ?? 0) > 0;
      if (hasRepairs) {
        ElMessage.warning('离线状态下登记返工修补可能与其他端的轮次冲突，请联网后再登记');
        return;
      }
      const stitchName = dict.value?.stitches.find((s) => s.id === form.value.stitchId)?.name ?? '修补';
      offline.enqueue({
        kind: 'repair-create',
        payload: buildRepairPayload(),
        baseDamageVersion: damage.value.version,
        summary: `${damage.value.garment.name} · ${damage.value.code} · ${stitchName}`,
      });
      ElMessage.warning('当前处于离线状态，修补登记已保存在本机，联网后会自动同步（后续用料与变化请在同步完成后补录）');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['garment'] }),
        queryClient.invalidateQueries({ queryKey: ['garments'] }),
      ]);
      void router.push({ name: 'damage-detail', params: { id: damageId } });
      return;
    }
    ElMessage.error(messageOf(error));
  } finally {
    busy.value = false;
  }
}

async function addMaterial(): Promise<void> {
  if (!materialForm.value.fabricSourceId) {
    ElMessage.warning('请选择布料来源');
    return;
  }
  busy.value = true;
  try {
    const result = await repairApi.addMaterial(repairId.value, {
      fabricSourceId: materialForm.value.fabricSourceId,
      amount: materialForm.value.amount,
      note: materialForm.value.note || undefined,
    });
    ElMessage.success(`已记录用料，剩余 ${result.inventory.remainingAmount}${result.inventory.unit}`);
    await refreshFabrics();
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    busy.value = false;
  }
}

async function refreshFabrics(): Promise<void> {
  fabricSources.value = (await fabricApi.list()).items;
}

async function saveChange(): Promise<void> {
  busy.value = true;
  try {
    await repairApi.saveChange(repairId.value, {
      visibility: change.value.visibility,
      colorMatch: change.value.colorMatch,
      stiffness: change.value.stiffness,
      drapeChange: change.value.drapeChange,
      comfortNote: change.value.comfortNote || null,
      mobilityLimited: change.value.mobilityLimited,
      visibleFromOutside: change.value.visibleFromOutside,
      dimensionChange: { lengthMm: change.value.lengthMm, widthMm: change.value.widthMm },
      photoBeforeId: change.value.photoBeforeId,
      photoAfterId: change.value.photoAfterId,
      wearTestNote: change.value.wearTestNote || null,
    });
    const observation = await repairApi.startObservation(repairId.value, form.value.observationDays);
    ElMessage.success(`已进入观察期，预计 ${observation.observationUntil.slice(0, 10)} 提醒复检`);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['garment'] }),
      queryClient.invalidateQueries({ queryKey: ['garments'] }),
      queryClient.invalidateQueries({ queryKey: ['reminders'] }),
      queryClient.invalidateQueries({ queryKey: ['wardrobe'] }),
    ]);
    await router.push({ name: 'repair-detail', params: { id: repairId.value } });
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
        <h1 class="page-title">登记修补</h1>
        <div class="page-subtitle">
          {{ damage ? `${damage.garment.name} · ${damage.code} · ${damage.damageType.name}` : '加载中…' }}
        </div>
      </div>
      <el-button link @click="router.back()">返回</el-button>
    </div>

    <el-steps :active="step" finish-status="success" style="margin-bottom: 16px">
      <el-step title="针法与执行" />
      <el-step title="用料与库存" />
      <el-step title="修补后变化" />
    </el-steps>

    <el-card v-if="step === 0" shadow="never">
      <el-form label-width="120px">
        <el-form-item label="谁修的" required>
          <el-radio-group v-model="form.executedBy">
            <el-radio-button v-for="item in EXECUTED_BY" :key="item" :label="item">{{ EXECUTED_BY_LABEL[item] }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="!isSelfRepair" label="店名">
          <el-input v-model="form.shopName" placeholder="楼下裁缝店" style="width: 240px" />
        </el-form-item>
        <el-form-item label="针法" required>
          <el-select v-model="form.stitchId" style="width: 280px">
            <el-option v-for="item in suggested" :key="item.id" :value="item.id" :label="`${item.name}（约 ${item.typicalMinutes ?? '—'} 分钟）`" />
          </el-select>
          <div class="field-hint">
            {{ dict?.stitches.find((s) => s.id === form.stitchId)?.description }}
          </div>
        </el-form-item>
        <el-form-item label="辅助针法">
          <el-select v-model="form.secondaryIds" multiple clearable style="width: 320px" placeholder="可多选，例如 先锁边再藏针">
            <el-option v-for="item in dict?.stitches ?? []" :key="item.id" :value="item.id" :label="item.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="线材 / 线色">
          <el-input v-model="form.threadType" placeholder="羊毛线" style="width: 200px" />
          <el-input v-model="form.threadColor" placeholder="深灰（与原色接近）" style="width: 240px; margin-left: 8px" />
        </el-form-item>
        <el-form-item label="起止日期" required>
          <el-date-picker v-model="form.startedAt" type="date" value-format="YYYY-MM-DD" style="width: 170px" />
          <span style="margin: 0 8px">→</span>
          <el-date-picker v-model="form.finishedAt" type="date" value-format="YYYY-MM-DD" style="width: 170px" />
        </el-form-item>
        <el-form-item label="耗时 / 花费">
          <el-input-number v-model="form.durationMinutes" :min="0" :max="10000" placeholder="分钟" style="width: 150px" />
          <el-input-number v-model="form.cost" :min="0" :precision="2" placeholder="自补记为耗材估值" style="width: 210px; margin-left: 8px" />
        </el-form-item>
        <el-form-item label="主观满意度">
          <el-radio-group v-model="form.resultRating">
            <el-radio-button v-for="item in RESULT_RATINGS" :key="item" :label="item">{{ RESULT_RATING_LABEL[item] }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="观察期天数">
          <el-input-number v-model="form.observationDays" :min="1" :max="365" :placeholder="isSelfRepair ? '默认 14 天' : '默认 7 天'" style="width: 180px" />
          <span class="muted" style="margin-left: 8px">到期会提醒你回来复检，这是闭环的关键一步</span>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" maxlength="1000" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="busy" @click="createRepair">创建修补记录</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card v-else-if="step === 1" shadow="never">
      <div class="muted" style="margin-bottom: 12px">
        用了哪块布、哪卷线？记下来之后，才回答得了"这块布到底救了几件衣服、平均撑多久"。
      </div>
      <el-form label-width="120px">
        <el-form-item label="布料来源">
          <el-select v-model="materialForm.fabricSourceId" style="width: 320px" placeholder="选择来源">
            <el-option
              v-for="source in fabricSources"
              :key="source.id"
              :value="source.id"
              :label="`${source.name}（${FABRIC_KIND_LABEL[source.kind as FabricKind]}，剩余 ${source.inventory?.remainingAmount ?? 0}${source.inventory?.unit ?? ''}）`"
            />
          </el-select>
          <el-button link type="primary" style="margin-left: 8px" @click="router.push({ name: 'fabric' })">管理库存</el-button>
        </el-form-item>
        <el-form-item label="用量">
          <el-input-number v-model="materialForm.amount" :min="0.1" :precision="1" style="width: 160px" />
          <div class="field-hint">超过余量会被拒绝，提示你换一块或先补货。</div>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="materialForm.note" placeholder="例如：织补用线" style="width: 300px" />
        </el-form-item>
        <el-form-item>
          <el-button :loading="busy" @click="addMaterial">添加这条用料</el-button>
          <el-button type="primary" @click="step = 2">下一步</el-button>
          <el-button link @click="step = 2">暂时不记用料</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card v-else shadow="never">
      <el-alert
        type="info"
        :closable="false"
        title="这一步必填"
        description="修补后的变化是这套档案最有价值的部分：三个月后你会想知道「补完之后穿起来到底怎么样」。"
        style="margin-bottom: 12px"
      />
      <el-form label-width="120px">
        <el-form-item label="外观痕迹">
          <el-radio-group v-model="change.visibility">
            <el-radio-button v-for="item in VISIBILITIES" :key="item" :label="item">{{ VISIBILITY_LABEL[item] }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="颜色匹配">
          <el-radio-group v-model="change.colorMatch">
            <el-radio-button v-for="item in COLOR_MATCHES" :key="item" :label="item">{{ COLOR_MATCH_LABEL[item] }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="手感">
          <el-radio-group v-model="change.stiffness">
            <el-radio-button v-for="item in STIFFNESS" :key="item" :label="item">{{ STIFFNESS_LABEL[item] }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="垂坠感">
          <el-radio-group v-model="change.drapeChange">
            <el-radio-button v-for="item in DRAPE_CHANGES" :key="item" :label="item">{{ DRAPE_CHANGE_LABEL[item] }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="尺寸变化">
          <el-input-number v-model="change.lengthMm" :min="-2000" :max="2000" style="width: 150px" />
          <span style="margin: 0 6px">×</span>
          <el-input-number v-model="change.widthMm" :min="-2000" :max="2000" style="width: 150px" />
          <span class="muted" style="margin-left: 8px">毫米，负数为变小</span>
        </el-form-item>
        <el-form-item label="穿着体感">
          <el-input v-model="change.comfortNote" type="textarea" :rows="2" maxlength="500" placeholder="例如：走路时有点勒 / 贴合度反而更好" />
        </el-form-item>
        <el-form-item label="影响">
          <el-checkbox v-model="change.mobilityLimited">影响活动（比如袖口变紧）</el-checkbox>
          <el-checkbox v-model="change.visibleFromOutside">外人能看出来</el-checkbox>
        </el-form-item>
        <el-form-item label="前后对比照">
          <div style="width: 100%">
            <div class="muted" style="margin-bottom: 6px">上传「修补前」与「修补后」各一张（若之前已拍过可直接选）</div>
            <el-select v-model="change.photoBeforeId" clearable placeholder="选择修补前照片" style="width: 260px">
              <el-option v-for="p in photos" :key="p.id" :value="p.id" :label="`${p.view} · ${p.capturedAt?.slice(0, 10) ?? ''}`" />
            </el-select>
            <el-select v-model="change.photoAfterId" clearable placeholder="选择修补后照片" style="width: 260px; margin-left: 8px">
              <el-option v-for="p in photos" :key="p.id" :value="p.id" :label="`${p.view} · ${p.capturedAt?.slice(0, 10) ?? ''}`" />
            </el-select>
            <div style="margin-top: 8px; max-width: 420px">
              <PhotoUploader :garment-id="damage?.garmentId ?? ''" default-view="after" @uploaded="(photo) => { photos.push(photo); change.photoAfterId = photo.id; }" />
            </div>
          </div>
        </el-form-item>
        <el-form-item label="试穿记录">
          <el-input v-model="change.wearTestNote" type="textarea" :rows="2" maxlength="500" placeholder="试穿多久、有没有异样" />
        </el-form-item>
        <el-form-item>
          <el-button @click="step = 1">上一步</el-button>
          <el-button type="primary" :loading="busy" @click="saveChange">保存并进入观察期</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>
