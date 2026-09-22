import type {
  DamageStatus,
  GarmentCategory,
  GarmentStatus,
  KnitOrWoven,
  MaterialPrimary,
  RepairStatus,
  Season,
  WearFrequencyBand,
  WearIntensity,
  WearSession,
} from '@gml/shared';

export interface User {
  id: string;
  email: string;
  displayName: string;
  timezone: string;
  reminderHour: number;
}

export interface Wardrobe {
  id: string;
  name: string;
  inviteCode: string;
  defaultReminderHour?: number;
  memberCount?: number;
}

export interface Garment {
  id: string;
  code: string;
  name: string;
  category: GarmentCategory;
  brand: string | null;
  sizeLabel: string | null;
  materialPrimary: MaterialPrimary;
  materialComposition: Array<{ fiber: string; pct: number }> | null;
  materialStretch: string | null;
  knitOrWoven: KnitOrWoven;
  seasonTags: Season[];
  color: string | null;
  purchaseDate: string | null;
  purchasePrice: string | null;
  careWashTemp: number | null;
  careMachineWash: boolean | null;
  careDryCleanOnly: boolean | null;
  careNote: string | null;
  status: GarmentStatus;
  retiredAt: string | null;
  disposition: string | null;
  dispositionNote: string | null;
  storageLocation: string | null;
  firstWearDate: string | null;
  lastWashedOn: string | null;
  wearsSinceWash: number;
  healthScore: number | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GarmentListItem {
  id: string;
  code: string;
  name: string;
  category: GarmentCategory;
  materialPrimary: MaterialPrimary;
  knitOrWoven: KnitOrWoven;
  seasonTags: Season[];
  status: GarmentStatus;
  statusLabel: string;
  color: string | null;
  storageLocation: string | null;
  thumbPhotoId: string | null;
  wearCount: number;
  perMonth: number;
  frequencyBand: WearFrequencyBand;
  repairCount: number;
  openDamageCount: number;
  costPerWear: number | null;
  serviceDays: number;
  healthScore: number;
  healthLevel: string;
  lastWornOn: string | null;
}

export interface PhotoAnnotationRow {
  id: string;
  photoId: string;
  garmentId: string;
  kind: 'point' | 'rect' | 'polyline';
  geometry: { x?: number; y?: number; w?: number; h?: number; points?: Array<{ x: number; y: number }> };
  radius: number | null;
  partId: string | null;
  label: string | null;
  color: string;
  damageEventId: string | null;
  repairId: string | null;
  status: 'draft' | 'linked';
  note: string | null;
  frozen: boolean;
  part?: { id: string; name: string } | null;
  damageEvent?: { id: string; code: string; damageType?: { name: string } } | null;
  repair?: { id: string; round: number; stitch?: { name: string } } | null;
}

export interface GarmentPhotoRow {
  id: string;
  garmentId: string;
  view: string;
  storagePath: string;
  thumbPath: string;
  width: number;
  height: number;
  sizeBytes: number;
  sha256: string;
  capturedAt: string | null;
  note: string | null;
  pairedPhotoId: string | null;
  annotations?: PhotoAnnotationRow[];
}

export interface RepairChange {
  id: string;
  visibility: string;
  colorMatch: string;
  stiffness: string;
  drapeChange: string;
  comfortNote: string | null;
  mobilityLimited: boolean;
  visibleFromOutside: boolean;
  dimensionChange: { lengthMm: number; widthMm: number } | null;
  wearTestNote: string | null;
  photoBeforeId: string | null;
  photoAfterId: string | null;
}

export interface ReviewResultRow {
  id: string;
  reviewedAt: string;
  verdict: 'good' | 'fair' | 'failed';
  daysSinceRepair: number;
  wornSince: number | null;
  reoccurred: boolean;
  verdictNote: string | null;
  nextAction: string;
}

export interface RepairRow {
  id: string;
  damageEventId: string;
  round: number;
  version: number;
  executedBy: string;
  shopName: string | null;
  cost: string | null;
  shopCost: string | null;
  durationMinutes: number | null;
  threadType: string | null;
  threadColor: string | null;
  startedAt: string;
  finishedAt: string;
  observationDays: number;
  observationUntil: string;
  status: RepairStatus;
  resultRating: string | null;
  note: string | null;
  reuseOriginalFabric: boolean;
  stitch: { id: string; name: string; code: string };
  change: RepairChange | null;
  reviews: ReviewResultRow[];
  materials: Array<{
    id: string;
    amount: number;
    unit: string;
    note: string | null;
    fabricSource: {
      id: string;
      name: string;
      materialPrimary: string;
      color: string | null;
      inventory?: { remainingAmount: number; unit: string } | null;
    };
  }>;
}

export interface DamageRow {
  id: string;
  code: string;
  garmentId: string;
  version: number;
  severity: 'minor' | 'moderate' | 'severe';
  status: DamageStatus;
  detectedAt: string;
  detectedSource: string;
  scheduledAt: string | null;
  description: string | null;
  causeGuess: string | null;
  measurableSize: { lengthMm: number; widthMm: number } | null;
  recurrenceOf: string | null;
  recurrenceIndex: number | null;
  locationUnknown: boolean;
  locationNote: string | null;
  damageType: { id: string; code: string; name: string };
  part?: { id: string; name: string } | null;
  repairs: RepairRow[];
  annotations?: PhotoAnnotationRow[];
  original?: { id: string; code: string; detectedAt?: string } | null;
  recurrences?: Array<{ id: string; code: string; detectedAt: string; status?: string }>;
}

export interface DamageListItem {
  id: string;
  code: string;
  garment: { id: string; code: string; name: string; materialPrimary: string };
  damageType: { id: string; name: string; code: string };
  part: { id: string; name: string } | null;
  severity: string;
  status: DamageStatus;
  detectedAt: string;
  scheduledAt: string | null;
  isRecurrence: boolean;
  recurrenceIndex: number | null;
  repairCount: number;
  lastRepair: { id: string; round: number; stitch: string; status: string; observationUntil: string; verdict: string | null } | null;
  annotationCount: number;
}

export interface RepairListItem {
  id: string;
  round: number;
  garment: { id: string; code: string; name: string };
  damageCode: string;
  damageType: string;
  part: string | null;
  stitch: string;
  executedBy: string;
  startedAt: string;
  finishedAt: string;
  observationUntil: string;
  status: RepairStatus;
  cost: string | null;
  hasChange: boolean;
  latestVerdict: string | null;
  materialCount: number;
}

export interface GarmentStats {
  wearCount: number;
  weightedWearCount: number;
  wearCountLast30: number;
  wearCountLast90: number;
  perMonth: number;
  frequencyBand: WearFrequencyBand;
  serviceDays: number;
  firstWearDate: string | null;
  lastWornOn: string | null;
  openDamageCount: number;
  damageCount: number;
  repairCount: number;
  recurrenceCount: number;
  repairedEventCount: number;
  recurrenceRate: number;
  totalRepairCost: number;
  totalMaterialCost: number;
  purchasePrice: number;
  costPerWear: number | null;
  seasonWearCounts: Record<string, number>;
}

export interface HealthFactor {
  key: string;
  label: string;
  ratio: number;
  weight: number;
  penalty: number;
  detail: string;
}

export interface HealthScore {
  score: number;
  level: 'good' | 'attention' | 'concern' | 'retire';
  advice: string;
  factors: HealthFactor[];
}

export interface GarmentDetailResponse {
  garment: Garment;
  stats: GarmentStats;
  health: HealthScore;
  photos: GarmentPhotoRow[];
  damages: DamageRow[];
  wearLogs: Array<{ id: string; wornOn: string; session: WearSession; intensity: WearIntensity; seasonSnapshot: string }>;
  orphanAnnotationCount: number;
  careRule: { wearCountBeforeWash: number; checkIntervalDays: number; avoid: string[]; washAdvice?: string } | null;
  material: { name: string; durabilityScore: number; washAdvice: string; dryAdvice: string; typicalWeakPoints: string[] } | null;
  suggestedStitches: Array<{ id: string; name: string; code: string; typicalMinutes: number | null; description: string }>;
}

export interface DamageDetail {
  damage: DamageRow & { garment: Garment };
  suggestedStitches: Array<{ id: string; name: string; code: string; description: string }>;
}

export interface RepairDetail {
  repair: RepairRow & { damageEvent: DamageRow & { garment: Garment } };
  secondaryStitches: Array<{ id: string; name: string }>;
  daysUntilObservationEnd: number;
  totalCost: number;
}

export interface TimelineEvent {
  type: 'damage' | 'repair' | 'review' | 'wear' | 'reminder';
  at: string;
  title: string;
  detail: string;
  refId: string;
  meta: Record<string, unknown>;
}

export interface WearLogRow {
  id: string;
  garmentId: string;
  wornOn: string;
  session: WearSession;
  intensity: WearIntensity;
  seasonSnapshot: string;
  occasion: string | null;
  note: string | null;
  garment?: { id: string; code: string; name: string };
}

export interface WearStats {
  garmentId: string;
  wearCount: number;
  weightedWearCount: number;
  wearCountLast30: number;
  wearCountLast90: number;
  perMonth: number;
  frequencyBand: WearFrequencyBand;
  seasonWearCounts: Record<string, number>;
  costPerWear: number | null;
  wearsSinceWash: number;
  lastWashedOn: string | null;
}

export interface WearCalendarResponse {
  month: string;
  days: Record<string, Array<{ garmentId: string; name: string; session: string; intensity: string }>>;
  totals: { wearCount: number; garmentCount: number; distinctGarments: number; averagePerDay: number };
}

export interface FabricSourceItem {
  id: string;
  name: string;
  kind: string;
  materialPrimary: MaterialPrimary;
  color: string | null;
  compositionNote: string | null;
  price: string | null;
  purchaseDate: string | null;
  purchaseLocation: string | null;
  isActive: boolean;
  donorGarment: { id: string; code: string; name: string } | null;
  usageCount: number;
  inventory: {
    id: string;
    unit: string;
    initialAmount: number;
    remainingAmount: number;
    lowStockThreshold: number;
    consumed: number;
    restocked: number;
    isLow: boolean;
  } | null;
}

export interface ReminderItem {
  id: string;
  subjectType: string;
  subjectId: string;
  title: string;
  body: string;
  reason: string;
  actionKind: string;
  actionPayload: Record<string, unknown> | null;
  dueAt: string;
  expireAt: string;
  status: string;
  occurrenceKey: string;
  priority: string;
  notifiedAt: string | null;
  handledAt: string | null;
  dismissReason: string | null;
  resultRef: Record<string, unknown> | null;
  isMine: boolean;
  isOverdue: boolean;
}

export interface ReminderSummary {
  overdue: number;
  today: number;
  upcoming: number;
  done: number;
  badge: number;
}

export interface ReminderRuleRow {
  id: string;
  code: string | null;
  name: string;
  triggerKind: string;
  params: Record<string, unknown>;
  scopeFilter: Record<string, unknown>;
  scheduleCron: string;
  channel: string;
  priority: string;
  isEnabled: boolean;
  isBuiltin: boolean;
  reminderCount: number;
  byStatus: Record<string, number>;
}

export interface DictionaryResponse {
  stitches: Array<{ id: string; code: string; name: string; suitableFabrics: string[]; suitableDamageTypes: string[]; difficulty: string; typicalMinutes: number | null; requiresMachine: boolean; description: string }>;
  damageTypes: Array<{ id: string; code: string; name: string; defaultSeverity: string; suggestedStitchCodes: string[]; typicalCauses: string[] }>;
  materials: Array<{ id: string; code: string; name: string; durabilityScore: number; washAdvice: string; dryAdvice: string; typicalWeakPoints: string[] }>;
  careRules: Array<{ materialCode: string; wearCountBeforeWash: number; checkIntervalDays: number; avoid: string[] }>;
  parts: Array<{ id: string; code: string; name: string; parentId: string | null; children: Array<Record<string, unknown>> }>;
  partsFlat: Array<{ id: string; code: string; name: string; parentId: string | null; category: string | null }>;
}

export interface AnalyticsOverview {
  overview: {
    garmentCount: number;
    activeCount: number;
    needsRepairCount: number;
    inRepairCount: number;
    observingCount: number;
    retiredCount: number;
    totalWearCount: number;
    totalRepairCount: number;
    recurrenceRate: number;
    averageLifespanDays: number | null;
    censoredLifespanCount: number;
    totalCost: number;
    lifetimeCostPerWear: number | null;
  };
  healthLevels: Record<string, number>;
  remindersByStatus: Record<string, number>;
}

export interface Insight {
  text: string;
  sampleSize: number;
  confident: boolean;
}

export interface ByMaterialResponse {
  rows: Array<{
    materialPrimary: MaterialPrimary;
    garmentCount: number;
    wearCount: number;
    repairCount: number;
    recurrenceRate: number;
    averageLifespanDays: number | null;
    censoredLifespanCount: number;
    observedLifespanCount: number;
    averageCostPerWear: number | null;
    topDamageTypes: Array<{ key: string; count: number }>;
    topParts: Array<{ key: string; count: number }>;
  }>;
  insights: Insight[];
}

export interface BySeasonResponse {
  rows: Array<{
    season: Season;
    garmentCount: number;
    wearCount: number;
    damageCount: number;
    wearCountPerDamage: number | null;
    wearShare: number;
  }>;
  insights: Insight[];
}

export interface ByFrequencyResponse {
  rows: Array<{
    band: WearFrequencyBand;
    garmentCount: number;
    wearCount: number;
    wearShare: number;
    averageRepairCount: number;
    averageLifespanDays: number | null;
    observedLifespanCount: number;
    censoredLifespanCount: number;
    averageCostPerWear: number | null;
    averageHealthScore: number | null;
  }>;
  insights: Insight[];
}

export interface StitchEffectivenessResponse {
  rows: Array<{
    stitchCode: string;
    materialPrimary: string;
    sampleCount: number;
    observedCount: number;
    censoredCount: number;
    averageLifespanDays: number | null;
    minObservedDays: number | null;
  }>;
  insights: Insight[];
}

export interface HealthDistributionResponse {
  levels: Record<string, number>;
  items: Array<{
    garmentId: string;
    code: string;
    name: string;
    materialPrimary: string;
    score: number;
    level: string;
    advice: string;
    wearCount: number;
    repairCount: number;
    costPerWear: number | null;
    frequencyBand: string;
    serviceDays: number;
  }>;
}

export interface LifetimeReport {
  garment: { id: string; code: string; name: string; status: string; materialPrimary: string; seasonTags: string[]; retiredAt: string | null; disposition: string | null };
  report: {
    serviceDays: number;
    firstWearDate: string | null;
    lastWornOn: string | null;
    wearCount: number;
    weightedWearCount: number;
    perMonth: number;
    frequencyBand: WearFrequencyBand;
    damageCount: number;
    repairCount: number;
    recurrenceCount: number;
    recurrenceRate: number;
    repurchasePrice: number;
    totalRepairCost: number;
    totalCost: number;
    costPerWear: number | null;
    health: HealthScore;
    lifespan: Array<{ repairId: string; days: number; censored: boolean; wears: number }>;
  };
  history: Array<{
    id: string;
    code: string;
    damageType: string;
    severity: string;
    part: string | null;
    detectedAt: string;
    status: string;
    isRecurrence: boolean;
    repairs: Array<{ id: string; round: number; stitch: string; finishedAt: string; status: string; verdict: string | null }>;
  }>;
}

export interface WardrobeOverviewResponse {
  wardrobe: Wardrobe;
  overview: AnalyticsOverview['overview'];
  todos: { dueReminders: number; upcoming: number; inventoryAlerts: number; orphanAnnotations: number };
  needingAttention: Array<{ id: string; code: string; name: string; status: GarmentStatus; healthScore: number | null }>;
}

export interface ShareLinkRow {
  id: string;
  scope: string;
  garmentIds: string[];
  expiresAt: string;
  accessCount: number;
  lastAccessAt: string | null;
  expired: boolean;
}
