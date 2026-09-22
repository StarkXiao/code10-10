import { api } from './client';
import type {
  AnalyticsOverview,
  ByFrequencyResponse,
  ByMaterialResponse,
  BySeasonResponse,
  DamageDetail,
  DamageListItem,
  DictionaryResponse,
  FabricSourceItem,
  GarmentDetailResponse,
  GarmentListItem,
  GarmentPhotoRow,
  HealthDistributionResponse,
  LifetimeReport,
  PhotoAnnotationRow,
  ReminderItem,
  ReminderRuleRow,
  ReminderSummary,
  RepairDetail,
  RepairListItem,
  ShareLinkRow,
  StitchEffectivenessResponse,
  TimelineEvent,
  User,
  Wardrobe,
  WardrobeOverviewResponse,
  WearCalendarResponse,
  WearLogRow,
  WearStats,
} from '../types';

/* ----------------------------- 账号与衣橱 ----------------------------- */

export const authApi = {
  register: (body: { email: string; password: string; displayName: string }) =>
    api.post<{ token: string; user: User; wardrobe: Wardrobe }>('/auth/register', body),
  login: (body: { email: string; password: string }) =>
    api.post<{ token: string; user: User; wardrobe: Wardrobe }>('/auth/login', body),
  me: () => api.get<{ user: User; wardrobe: Wardrobe }>('/auth/me'),
  updateProfile: (body: Partial<Pick<User, 'displayName' | 'timezone' | 'reminderHour'>>) =>
    api.patch<{ user: User }>('/auth/me', body),
};

export const wardrobeApi = {
  overview: () => api.get<WardrobeOverviewResponse>('/wardrobe'),
  update: (body: { name?: string; defaultReminderHour?: number }) => api.patch<{ wardrobe: Wardrobe }>('/wardrobe', body),
  rotateInvite: () => api.post<{ inviteCode: string }>('/wardrobe/invite-code/rotate'),
  join: (inviteCode: string) => api.post<{ wardrobeId: string; name: string }>('/wardrobe/join', { inviteCode }),
  members: () =>
    api.get<{ members: Array<{ userId: string; displayName: string; email: string; role: string; isMe: boolean }> }>(
      '/wardrobe/members',
    ),
  dictionary: () => api.get<DictionaryResponse>('/dictionary'),
  activityLogs: (params?: { entityType?: string; limit?: number }) =>
    api.get<{ logs: Array<Record<string, unknown>> }>('/activity-logs', params),
};

/* ----------------------------- 衣物档案 ----------------------------- */

export const garmentApi = {
  list: (params: Record<string, unknown>) =>
    api.get<{ items: GarmentListItem[]; total: number; page: number; totalPages: number }>('/garments', params),
  create: (body: Record<string, unknown>) => api.post<{ garment: GarmentDetailResponse['garment'] }>('/garments', body),
  detail: (id: string) => api.get<GarmentDetailResponse>(`/garments/${id}`),
  update: (id: string, body: Record<string, unknown>) =>
    api.patch<{ garment: GarmentDetailResponse['garment'] }>(`/garments/${id}`, body),
  retire: (id: string, body: { disposition: string; dispositionNote?: string }) =>
    api.post<{ garment: GarmentDetailResponse['garment']; expiredDamageCount: number }>(`/garments/${id}/retire`, body),
  restore: (id: string) => api.post<{ status: string }>(`/garments/${id}/restore`),
  remove: (id: string) => api.del<{ deleted: boolean }>(`/garments/${id}`),
  timeline: (id: string) => api.get<{ events: TimelineEvent[] }>(`/garments/${id}/timeline`),
  lifetime: (id: string) => api.get<LifetimeReport>(`/garments/${id}/lifetime-report`),
  wearStats: (id: string) => api.get<WearStats>(`/garments/${id}/wear-stats`),
  washed: (id: string, body: { washedOn?: string; note?: string } = {}) =>
    api.post<{ lastWashedOn: string; wearsSinceWash: number; closedReminders: number }>(`/garments/${id}/washed`, body),
  orphanAnnotations: (id: string) => api.get<{ annotations: PhotoAnnotationRow[] }>(`/garments/${id}/annotations/orphans`),
};

/* ----------------------------- 照片与标记 ----------------------------- */

export const photoApi = {
  list: (garmentId: string) => api.get<{ photos: GarmentPhotoRow[] }>(`/garments/${garmentId}/photos`),
  upload: (garmentId: string, form: FormData) => api.upload<{ photo: GarmentPhotoRow }>(`/garments/${garmentId}/photos`, form),
  update: (id: string, body: Record<string, unknown>) => api.patch<{ photo: GarmentPhotoRow }>(`/photos/${id}`, body),
  remove: (id: string) => api.del<{ deleted: boolean }>(`/photos/${id}`),
  annotations: (photoId: string) =>
    api.get<{ annotations: PhotoAnnotationRow[]; photo: GarmentPhotoRow }>(`/photos/${photoId}/annotations`),
  createAnnotations: (photoId: string, annotations: Array<Record<string, unknown>>) =>
    api.post<{ annotations: PhotoAnnotationRow[]; draftCount: number }>(`/photos/${photoId}/annotations`, { annotations }),
  updateAnnotation: (id: string, body: Record<string, unknown>) =>
    api.patch<{ annotation: PhotoAnnotationRow }>(`/annotations/${id}`, body),
  deleteAnnotation: (id: string) => api.del<{ deleted?: boolean; annotation?: PhotoAnnotationRow; unfrozen?: boolean }>(`/annotations/${id}`),
  linkAnnotation: (id: string, body: { damageEventId?: string; repairId?: string; partId?: string; label?: string }) =>
    api.post<{ annotation: PhotoAnnotationRow }>(`/annotations/${id}/link`, body),
  fileUrl: (photoId: string, variant: 'file' | 'thumb' = 'file') => `/api/photos/${photoId}/${variant}`,
};

/* ----------------------------- 破损 ----------------------------- */

export const damageApi = {
  list: (params: Record<string, unknown> = {}) => api.get<{ items: DamageListItem[] }>('/damage-events', params),
  create: (body: Record<string, unknown>) => api.post<{ damage: DamageDetail['damage'] }>('/damage-events', body),
  detail: (id: string) => api.get<DamageDetail>(`/damage-events/${id}`),
  update: (id: string, body: Record<string, unknown>) => api.patch<{ damage: DamageDetail['damage'] }>(`/damage-events/${id}`, body),
  schedule: (id: string, scheduledAt: string) => api.post<{ damage: DamageDetail['damage'] }>(`/damage-events/${id}/schedule`, { scheduledAt }),
  markUnrepairable: (id: string, reason: string) => api.post<{ damage: DamageDetail['damage'] }>(`/damage-events/${id}/mark-unrepairable`, { reason }),
  cancel: (id: string, reason: string) => api.post<{ damage: DamageDetail['damage'] }>(`/damage-events/${id}/cancel`, { reason }),
  recurrenceCandidates: (id: string) =>
    api.get<{ candidates: Array<{ id: string; code: string; detectedAt: string; damageType: string; part: string | null; lastStitch: string | null; daysSince: number }> }>(
      `/damage-events/${id}/recurrence-candidates`,
    ),
  linkRecurrence: (id: string, recurrenceOfId: string) =>
    api.post<{ damage: DamageDetail['damage'] }>(`/damage-events/${id}/link-recurrence`, { recurrenceOfId }),
};

/* ----------------------------- 修补与复检 ----------------------------- */

export const repairApi = {
  list: (params: Record<string, unknown> = {}) => api.get<{ items: RepairListItem[] }>('/repairs', params),
  create: (body: Record<string, unknown>) => api.post<{ repair: RepairDetail['repair']; nextStep: string }>('/repairs', body),
  detail: (id: string) => api.get<RepairDetail>(`/repairs/${id}`),
  update: (id: string, body: Record<string, unknown>) => api.patch<{ repair: RepairDetail['repair'] }>(`/repairs/${id}`, body),
  addMaterial: (id: string, body: { fabricSourceId: string; amount: number; note?: string }) =>
    api.post<{ inventory: { remainingAmount: number; unit: string } }>(`/repairs/${id}/materials`, body),
  removeMaterial: (id: string, materialId: string) => api.del<{ removed: boolean }>(`/repairs/${id}/materials/${materialId}`),
  saveChange: (id: string, body: Record<string, unknown>) => api.put<{ change: unknown }>(`/repairs/${id}/change`, body),
  startObservation: (id: string, observationDays?: number) =>
    api.post<{ observationUntil: string; reminderCreated: boolean }>(`/repairs/${id}/start-observation`, observationDays ? { observationDays } : {}),
  review: (id: string, body: Record<string, unknown>) => api.post<Record<string, unknown>>(`/repairs/${id}/review`, body),
  comparison: (id: string) => api.get<Record<string, unknown>>(`/repairs/${id}/comparison`),
  worksheet: (id: string) => api.post<{ url: string }>(`/repairs/${id}/worksheet`),
};

/* ----------------------------- 穿着 ----------------------------- */

export const wearApi = {
  create: (body: Record<string, unknown>) => api.post<{ duplicate: boolean; wearLog: WearLogRow }>('/wear-logs', body),
  batch: (logs: Array<Record<string, unknown>>) => api.post<{ created: number; duplicates: number; failed: number }>('/wear-logs/batch', { logs }),
  list: (params: Record<string, unknown> = {}) => api.get<{ logs: WearLogRow[] }>('/wear-logs', params),
  calendar: (month: string) => api.get<WearCalendarResponse>('/wear-logs/calendar', { month }),
  remove: (id: string) => api.del<{ deleted: boolean }>(`/wear-logs/${id}`),
};

/* ----------------------------- 离线同步 ----------------------------- */

export type SyncOpKind = 'wear-log' | 'damage-create' | 'repair-create';

export interface SyncOpResult {
  opId: string;
  kind: SyncOpKind;
  status: 'ok' | 'duplicate' | 'rejected' | 'conflict';
  entityType?: string;
  entityId?: string;
  code?: string;
  version?: number;
  errorCode?: string;
  message?: string;
  conflict?: unknown;
}

export const syncApi = {
  batch: (ops: Array<Record<string, unknown>>) =>
    api.post<{
      results: SyncOpResult[];
      synced: number;
      duplicates: number;
      rejected: number;
      conflicts: number;
    }>('/sync', { ops }),
};

/* ----------------------------- 布料库存 ----------------------------- */

export const fabricApi = {
  list: () => api.get<{ items: FabricSourceItem[] }>('/fabric-sources'),
  create: (body: Record<string, unknown>) => api.post<{ fabricSource: FabricSourceItem }>('/fabric-sources', body),
  update: (id: string, body: Record<string, unknown>) => api.patch<{ fabricSource: FabricSourceItem }>(`/fabric-sources/${id}`, body),
  restock: (id: string, amount: number, note?: string) =>
    api.post<{ inventory: { remainingAmount: number } }>(`/fabric-sources/${id}/restock`, { amount, note }),
  adjust: (id: string, amount: number, reason: string) =>
    api.post<{ inventory: { remainingAmount: number } }>(`/fabric-sources/${id}/adjust`, { amount, reason }),
  txns: (id: string) => api.get<{ txns: Array<Record<string, unknown>> }>(`/fabric-sources/${id}/txns`),
  usage: (id: string) => api.get<{ usages: Array<Record<string, unknown>>; effectiveness: Record<string, unknown> }>(`/fabric-sources/${id}/usage`),
};

/* ----------------------------- 提醒 ----------------------------- */

export const reminderApi = {
  list: (params: Record<string, unknown>) => api.get<{ items: ReminderItem[] }>('/reminders', params),
  summary: () => api.get<ReminderSummary>('/reminders/summary'),
  complete: (id: string, body: Record<string, unknown> = {}) => api.post<{ reminder: ReminderItem }>(`/reminders/${id}/complete`, body),
  snooze: (id: string, snoozeUntil: string, note?: string) => api.post<{ reminder: ReminderItem }>(`/reminders/${id}/snooze`, { snoozeUntil, note }),
  dismiss: (id: string, reason: string, note?: string) => api.post<{ reminder: ReminderItem }>(`/reminders/${id}/dismiss`, { reason, note }),
  act: (id: string, body: Record<string, unknown>) => api.post<Record<string, unknown>>(`/reminders/${id}/action`, body),
  rules: () => api.get<{ rules: ReminderRuleRow[] }>('/reminder-rules'),
  createRule: (body: Record<string, unknown>) => api.post<{ rule: ReminderRuleRow }>('/reminder-rules', body),
  updateRule: (id: string, body: Record<string, unknown>) => api.patch<{ rule: ReminderRuleRow }>(`/reminder-rules/${id}`, body),
  deleteRule: (id: string) => api.del<{ deleted?: boolean; disabled?: boolean }>(`/reminder-rules/${id}`),
  runNow: () => api.post<{ created: number; notified: number; expired: number }>('/reminder-rules/run-now'),
  scan: () => api.post<{ created: number; notified: number; expired: number }>('/wardrobe/scan-reminders'),
};

/* ----------------------------- 分析 ----------------------------- */

export const analyticsApi = {
  overview: () => api.get<AnalyticsOverview>('/analytics/overview'),
  byMaterial: () => api.get<ByMaterialResponse>('/analytics/by-material'),
  bySeason: () => api.get<BySeasonResponse>('/analytics/by-season'),
  byFrequency: () => api.get<ByFrequencyResponse>('/analytics/by-frequency'),
  stitchEffectiveness: () => api.get<StitchEffectivenessResponse>('/analytics/stitch-effectiveness'),
  healthDistribution: () => api.get<HealthDistributionResponse>('/analytics/health-distribution'),
  wearTrend: (months = 12) => api.get<{ months: Array<{ month: string; wearCount: number; damageCount: number }> }>('/analytics/wear-trend', { months }),
};

/* ----------------------------- 分享 ----------------------------- */

export const shareApi = {
  list: () => api.get<{ links: ShareLinkRow[] }>('/share-links'),
  create: (body: { scope: string; garmentIds: string[]; expiresInHours?: number }) =>
    api.post<{ id: string; token: string; url: string; expiresAt: string }>('/share-links', body),
  revoke: (id: string) => api.del<{ revoked: boolean }>(`/share-links/${id}`),
  publicData: (token: string) =>
    api.get<{ wardrobeName: string; scope: string; garments: Array<{ id: string; code: string; name: string }>; expiresAt: string }>(
      `/share/${token}`,
    ),
  publicGarment: (token: string, garmentId: string) => api.get<Record<string, unknown>>(`/share/${token}/garment/${garmentId}`),
};
