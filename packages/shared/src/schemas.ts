/**
 * 前后端共用的校验规则（Zod）。
 * 表单校验、接口入参校验、错误提示都引用这里，避免两端规则漂移。
 */
import { z } from 'zod';
import {
  ANNOTATION_KINDS,
  CAUSE_GUESSES,
  COLOR_MATCHES,
  DAMAGE_TYPES,
  DETECTED_SOURCES,
  DISMISS_REASONS,
  DISPOSITIONS,
  DRAPE_CHANGES,
  EXECUTED_BY,
  FABRIC_KINDS,
  GARMENT_CATEGORIES,
  GARMENT_STATUSES,
  INVENTORY_UNITS,
  KNIT_OR_WOVEN,
  MATERIAL_PRIMARIES,
  NEXT_ACTIONS,
  PHOTO_VIEWS,
  REMINDER_TRIGGER_KINDS,
  RESULT_RATINGS,
  SEASONS,
  SEVERITIES,
  STITCH_CODES,
  STIFFNESS,
  VERDICTS,
  VISIBILITIES,
  WEAR_INTENSITIES,
  WEAR_SESSIONS,
} from './enums.js';

/**
 * 严格日期：除格式外还要求"这一天真实存在"。
 * 否则 2026-02-31 会被 Date 自动进位成 3 月 3 日，档案里悄悄多出一个错误日期。
 */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    if (year < 1900 || year > 2100) return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    );
  }, '这个日期不存在，请检查年月日')
  .describe('YYYY-MM-DD');

/** 允许 1 天时区误差，但拦住 2062 这种把统计彻底带偏的手误 */
const notTooFarInFuture = (slackDays = 1) =>
  isoDate.refine((value) => {
    const limit = new Date(Date.now() + slackDays * 86_400_000);
    return new Date(`${value}T00:00:00Z`).getTime() <= limit.getTime();
  }, '日期不能在未来（请检查是否填错年份）');

const coord = z.number().min(0).max(1);

export const pointGeometrySchema = z.object({ x: coord, y: coord });
export const rectGeometrySchema = z.object({ x: coord, y: coord, w: coord, h: coord });
export const polylineGeometrySchema = z.object({
  points: z.array(pointGeometrySchema).min(2, '折线至少需要 2 个点'),
});

export const annotationBaseSchema = z.object({
    kind: z.enum(ANNOTATION_KINDS),
    geometry: z.record(z.unknown()),
    radius: z.number().min(0.001).max(0.5).optional(),
    partId: z.string().min(1).nullable().optional(),
    label: z.string().max(120).nullable().optional(),
    color: z.string().max(16).optional(),
    damageEventId: z.string().min(1).nullable().optional(),
    repairId: z.string().min(1).nullable().optional(),
    note: z.string().max(500).nullable().optional(),
  });

export const annotationInputSchema = annotationBaseSchema.superRefine((value, ctx) => {
    const parsed =
      value.kind === 'point'
        ? pointGeometrySchema.safeParse(value.geometry)
        : value.kind === 'rect'
          ? rectGeometrySchema.safeParse(value.geometry)
          : polylineGeometrySchema.safeParse(value.geometry);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['geometry'],
        message: `几何数据与 kind=${value.kind} 不匹配`,
      });
    }
  });

export const annotationBatchSchema = z.object({
  annotations: z.array(annotationInputSchema).min(1, '至少需要一个标记').max(50),
});

export const registerSchema = z.object({
  email: z.string().email('请输入有效邮箱'),
  password: z.string().min(6, '密码至少 6 位').max(72),
  displayName: z.string().min(1, '请填写称呼').max(40),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const profileUpdateSchema = z.object({
  displayName: z.string().min(1).max(40).optional(),
  timezone: z.string().min(1).max(64).optional(),
  reminderHour: z.number().int().min(0).max(23).optional(),
});

export const wardrobeUpdateSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  defaultReminderHour: z.number().int().min(0).max(23).optional(),
});

export const materialCompositionSchema = z.array(
  z.object({ fiber: z.string().min(1).max(30), pct: z.number().min(0).max(100) }),
);

export const garmentCreateSchema = z.object({
  name: z.string().min(1, '请填写衣物名称').max(60),
  category: z.enum(GARMENT_CATEGORIES),
  brand: z.string().max(60).nullable().optional(),
  sizeLabel: z.string().max(30).nullable().optional(),
  materialPrimary: z.enum(MATERIAL_PRIMARIES),
  materialComposition: materialCompositionSchema.nullable().optional(),
  materialStretch: z.enum(['none', 'slight', 'high']).nullable().optional(),
  knitOrWoven: z.enum(KNIT_OR_WOVEN),
  seasonTags: z.array(z.enum(SEASONS)).min(1, '至少选择一个季节'),
  color: z.string().max(30).nullable().optional(),
  purchaseDate: isoDate.nullable().optional(),
  purchasePrice: z.number().min(0).max(1_000_000).nullable().optional(),
  careWashTemp: z.number().int().min(0).max(95).nullable().optional(),
  careMachineWash: z.boolean().nullable().optional(),
  careDryCleanOnly: z.boolean().nullable().optional(),
  careNote: z.string().max(300).nullable().optional(),
  storageLocation: z.string().max(60).nullable().optional(),
  firstWearDate: isoDate.nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
});

export const garmentUpdateSchema = garmentCreateSchema.partial().extend({
  status: z.enum(GARMENT_STATUSES).optional(),
});

export const garmentRetireSchema = z.object({
  disposition: z.enum(DISPOSITIONS),
  dispositionNote: z.string().max(300).nullable().optional(),
  retiredAt: isoDate.optional(),
});

export const photoUpdateSchema = z.object({
  view: z.enum(PHOTO_VIEWS).optional(),
  note: z.string().max(300).nullable().optional(),
  pairedPhotoId: z.string().min(1).nullable().optional(),
  capturedAt: z.string().nullable().optional(),
});

export const photoUploadSchema = z.object({
  view: z.enum(PHOTO_VIEWS),
  capturedAt: z.string().nullable().optional(),
  note: z.string().max(300).nullable().optional(),
});

export const damageCreateBaseSchema = z.object({
  garmentId: z.string().min(1),
  damageTypeId: z.string().min(1),
  severity: z.enum(SEVERITIES),
  partId: z.string().min(1).nullable().optional(),
  detectedAt: notTooFarInFuture(),
  detectedSource: z.enum(DETECTED_SOURCES).default('self'),
  description: z.string().max(1000).nullable().optional(),
  causeGuess: z.enum(CAUSE_GUESSES).nullable().optional(),
  measurableSize: z
    .object({ lengthMm: z.number().min(0).max(5000), widthMm: z.number().min(0).max(5000) })
    .nullable()
    .optional(),
  annotationIds: z.array(z.string().min(1)).default([]),
  locationUnknown: z.boolean().default(false),
  locationNote: z.string().max(200).nullable().optional(),
  scheduledAt: isoDate.nullable().optional(),
  recurrenceOfId: z.string().min(1).nullable().optional(),
  /** 离线登记幂等键：断网时客户端生成，重放只建一条 */
  clientOpId: z.string().min(1).max(64).nullable().optional(),
});

/** 破损位置规则：要么有照片标记，要么明确说明"位置不便标记" */
export function damageLocationRule(
  value: z.infer<typeof damageCreateBaseSchema>,
  ctx: z.RefinementCtx,
): void {
  if (!value.locationUnknown && value.annotationIds.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['annotationIds'],
      message: '请在照片上标记破损位置，或勾选“位置不便标记”并说明',
    });
  }
  if (value.locationUnknown && !value.locationNote) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['locationNote'],
      message: '选择“位置不便标记”时必须说明原因',
    });
  }
}

export const damageCreateSchema = damageCreateBaseSchema.superRefine(damageLocationRule);

export const damageUpdateSchema = z.object({
  damageTypeId: z.string().min(1).optional(),
  severity: z.enum(SEVERITIES).optional(),
  partId: z.string().min(1).nullable().optional(),
  detectedAt: isoDate.optional(),
  description: z.string().max(1000).nullable().optional(),
  causeGuess: z.enum(CAUSE_GUESSES).nullable().optional(),
  measurableSize: z
    .object({ lengthMm: z.number().min(0).max(5000), widthMm: z.number().min(0).max(5000) })
    .nullable()
    .optional(),
  /** 编辑前看到的版本号；与服务端不一致说明被其他端改过，按 409 冲突处理 */
  expectedVersion: z.number().int().min(1).optional(),
});

export const damageScheduleSchema = z.object({
  scheduledAt: isoDate,
});

export const damageCancelSchema = z.object({
  reason: z.string().min(1, '请填写取消原因').max(300),
});

export const damageLinkRecurrenceSchema = z.object({
  recurrenceOfId: z.string().min(1),
});

export const repairCreateBaseSchema = z.object({
  damageEventId: z.string().min(1),
  executedBy: z.enum(EXECUTED_BY),
  shopName: z.string().max(60).nullable().optional(),
  shopCost: z.number().min(0).max(1_000_000).nullable().optional(),
  stitchId: z.string().min(1),
  stitchSecondaryIds: z.array(z.string().min(1)).default([]),
  threadType: z.string().max(60).nullable().optional(),
  threadColor: z.string().max(30).nullable().optional(),
  durationMinutes: z.number().int().min(0).max(10_000).nullable().optional(),
  cost: z.number().min(0).max(1_000_000).nullable().optional(),
  startedAt: notTooFarInFuture(),
  finishedAt: notTooFarInFuture(),
  resultRating: z.enum(RESULT_RATINGS).nullable().optional(),
  observationDays: z.number().int().min(1).max(365).nullable().optional(),
  reuseOriginalFabric: z.boolean().default(false),
  note: z.string().max(1000).nullable().optional(),
  /** 离线登记幂等键：断网时客户端生成，重放只建一条 */
  clientOpId: z.string().min(1).max(64).nullable().optional(),
});

/** 修补起止日期规则：完成不能早于开始 */
export function repairDateRule(value: z.infer<typeof repairCreateBaseSchema>, ctx: z.RefinementCtx): void {
  if (value.finishedAt < value.startedAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['finishedAt'],
      message: '完成日期不能早于开始日期',
    });
  }
}

export const repairCreateSchema = repairCreateBaseSchema.superRefine(repairDateRule);

export const repairUpdateSchema = z.object({
  stitchId: z.string().min(1).optional(),
  stitchSecondaryIds: z.array(z.string().min(1)).optional(),
  threadType: z.string().max(60).nullable().optional(),
  threadColor: z.string().max(30).nullable().optional(),
  durationMinutes: z.number().int().min(0).max(10_000).nullable().optional(),
  cost: z.number().min(0).max(1_000_000).nullable().optional(),
  resultRating: z.enum(RESULT_RATINGS).nullable().optional(),
  observationDays: z.number().int().min(1).max(365).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
  /** 编辑前看到的版本号；与服务端不一致说明被其他端改过，按 409 冲突处理 */
  expectedVersion: z.number().int().min(1).optional(),
});

export const repairMaterialSchema = z.object({
  fabricSourceId: z.string().min(1),
  amount: z.number().positive('用量必须大于 0'),
  note: z.string().max(200).nullable().optional(),
});

export const repairChangeSchema = z.object({
  visibility: z.enum(VISIBILITIES),
  colorMatch: z.enum(COLOR_MATCHES),
  dimensionChange: z
    .object({ lengthMm: z.number().min(-2000).max(2000), widthMm: z.number().min(-2000).max(2000) })
    .nullable()
    .optional(),
  stiffness: z.enum(STIFFNESS),
  drapeChange: z.enum(DRAPE_CHANGES),
  comfortNote: z.string().max(500).nullable().optional(),
  mobilityLimited: z.boolean().default(false),
  visibleFromOutside: z.boolean().default(false),
  photoBeforeId: z.string().min(1).nullable().optional(),
  photoAfterId: z.string().min(1).nullable().optional(),
  wearTestNote: z.string().max(500).nullable().optional(),
});

export const startObservationSchema = z.object({
  observationDays: z.number().int().min(1).max(365).optional(),
});

export const reviewSchema = z
  .object({
    reviewedAt: notTooFarInFuture(),
    verdict: z.enum(VERDICTS),
    wornSince: z.number().int().min(0).nullable().optional(),
    reoccurred: z.boolean().default(false),
    verdictNote: z.string().max(1000).nullable().optional(),
    nextAction: z.enum(NEXT_ACTIONS),
    /** 观察期还没结束时要显式确认提前复检（对应错误码 OBSERVATION_NOT_FINISHED） */
    confirmEarly: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.verdict === 'failed' && value.nextAction === 'close') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nextAction'],
        message: '复检不合格时不能直接闭环，请选择返工或退役',
      });
    }
  });

export const wearLogSchema = z.object({
  garmentId: z.string().min(1),
  wornOn: notTooFarInFuture(),
  session: z.enum(WEAR_SESSIONS).default('full_day'),
  intensity: z.enum(WEAR_INTENSITIES).default('normal'),
  seasonSnapshot: z.enum(SEASONS).optional(),
  weatherSnapshot: z.record(z.unknown()).nullable().optional(),
  occasion: z.string().max(40).nullable().optional(),
  note: z.string().max(300).nullable().optional(),
  clientOpId: z.string().min(1).max(64).nullable().optional(),
});

export const wearLogBatchSchema = z.object({
  logs: z.array(wearLogSchema).min(1).max(200),
});

/**
 * 离线队列批量同步：断网时各端把破损/修补/穿着登记先落本地，
 * 联网后整批提交；服务端逐条处理并逐条回报（成功 / 幂等 / 业务拒绝 / 版本冲突）。
 *
 * clientOpId 由批量层统一注入为 opId（见 services 端组装），负载里不再单独传。
 */
export const offlineDamagePayloadSchema = damageCreateBaseSchema
  .omit({ clientOpId: true })
  .superRefine(damageLocationRule);

export const offlineRepairPayloadSchema = repairCreateBaseSchema
  .omit({ clientOpId: true })
  .superRefine(repairDateRule);

export const offlineSyncOpSchema = z.discriminatedUnion('kind', [
  z.object({
    opId: z.string().min(1).max(64),
    kind: z.literal('wear-log'),
    payload: wearLogSchema.omit({ clientOpId: true }),
  }),
  z.object({
    opId: z.string().min(1).max(64),
    kind: z.literal('damage-create'),
    payload: offlineDamagePayloadSchema,
  }),
  z.object({
    opId: z.string().min(1).max(64),
    kind: z.literal('repair-create'),
    payload: offlineRepairPayloadSchema,
    /** 登记修补时本地看到的破损版本，用来发现"离线期间别的端已经改过这条破损" */
    expectedDamageVersion: z.number().int().min(1).optional(),
  }),
]);

export const offlineSyncSchema = z.object({
  ops: z.array(offlineSyncOpSchema).min(1).max(100),
});

export const fabricSourceSchema = z.object({
  name: z.string().min(1, '请填写来源名称').max(60),
  kind: z.enum(FABRIC_KINDS),
  donorGarmentId: z.string().min(1).nullable().optional(),
  materialPrimary: z.enum(MATERIAL_PRIMARIES),
  color: z.string().max(30).nullable().optional(),
  compositionNote: z.string().max(200).nullable().optional(),
  price: z.number().min(0).max(1_000_000).nullable().optional(),
  purchaseDate: isoDate.nullable().optional(),
  purchaseLocation: z.string().max(60).nullable().optional(),
  inventory: z
    .object({
      unit: z.enum(INVENTORY_UNITS),
      initialAmount: z.number().positive(),
      lowStockThreshold: z.number().min(0).nullable().optional(),
    })
    .optional(),
});

export const fabricSourceUpdateSchema = fabricSourceSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const inventoryRestockSchema = z.object({
  amount: z.number().positive(),
  note: z.string().max(200).nullable().optional(),
});

export const inventoryAdjustSchema = z.object({
  amount: z.number(),
  reason: z.string().min(1, '盘点调整必须填写原因').max(200),
});

export const reminderRuleSchema = z.object({
  name: z.string().min(1).max(60),
  triggerKind: z.enum(REMINDER_TRIGGER_KINDS),
  params: z.record(z.unknown()).default({}),
  scopeFilter: z.record(z.unknown()).default({}),
  scheduleCron: z.string().max(60).default('0 * * * *'),
  channel: z.enum(['inapp', 'inapp_email', 'inapp_webhook']).default('inapp'),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  isEnabled: z.boolean().default(true),
});

export const reminderRuleUpdateSchema = reminderRuleSchema.partial();

export const reminderCompleteSchema = z.object({
  resultRef: z.record(z.unknown()).nullable().optional(),
  note: z.string().max(300).nullable().optional(),
});

export const reminderSnoozeSchema = z.object({
  snoozeUntil: z.string().min(1),
  note: z.string().max(300).nullable().optional(),
});

export const reminderDismissSchema = z.object({
  reason: z.enum(DISMISS_REASONS),
  note: z.string().max(300).nullable().optional(),
});

export const reminderActionSchema = z.object({
  /** 复检类提醒可直接提交结论，实现"一键执行" */
  review: reviewSchema.optional(),
  note: z.string().max(300).nullable().optional(),
});

export const shareLinkSchema = z.object({
  scope: z.enum(['garment', 'wardrobe']).default('garment'),
  garmentIds: z.array(z.string().min(1)).default([]),
  expiresInHours: z.number().int().min(1).max(24 * 365).optional(),
});

export const stitchCreateSchema = z.object({
  name: z.string().min(1).max(40),
  code: z.string().min(1).max(40),
  suitableFabrics: z.array(z.string()).default([]),
  suitableDamageTypes: z.array(z.string()).default([]),
  difficulty: z.enum(['easy', 'medium', 'hard']).default('easy'),
  typicalMinutes: z.number().int().min(0).max(1000).nullable().optional(),
  requiresMachine: z.boolean().default(false),
  description: z.string().max(2000).default(''),
});

export const damageTypeCreateSchema = z.object({
  name: z.string().min(1).max(40),
  code: z.string().min(1).max(40),
  defaultSeverity: z.enum(SEVERITIES).default('moderate'),
  suggestedStitchCodes: z.array(z.string()).default([]),
  typicalCauses: z.array(z.string()).default([]),
});

export const partCreateSchema = z.object({
  name: z.string().min(1).max(40),
  code: z.string().min(1).max(40),
  parentId: z.string().min(1).nullable().optional(),
  category: z.string().max(30).nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).default(100),
});

export type AnnotationInput = z.infer<typeof annotationInputSchema>;
export type GarmentCreateInput = z.infer<typeof garmentCreateSchema>;
export type GarmentUpdateInput = z.infer<typeof garmentUpdateSchema>;
export type DamageCreateInput = z.infer<typeof damageCreateSchema>;
export type RepairCreateInput = z.infer<typeof repairCreateSchema>;
export type RepairChangeInput = z.infer<typeof repairChangeSchema>;
export type ReviewInput = z.infer<typeof reviewSchema>;
export type WearLogInput = z.infer<typeof wearLogSchema>;
export type FabricSourceInput = z.infer<typeof fabricSourceSchema>;
export type ReminderRuleInput = z.infer<typeof reminderRuleSchema>;
