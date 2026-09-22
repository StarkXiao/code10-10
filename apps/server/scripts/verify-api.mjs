#!/usr/bin/env node
/**
 * 接口全量扫描：把所有只读端点真实打一遍，检查状态码与响应结构。
 * 与 smoke.mjs 的分工：
 *   - smoke.mjs 验证「写链路 + 闭环语义」（断言业务结果）；
 *   - verify-api.mjs 验证「每个 GET 端点都能正常返回」（防止某个页面一打开就 500）。
 *
 * 用法：node apps/server/scripts/verify-api.mjs [baseUrl]
 */
import { createRequire } from 'node:module';

const BASE = process.argv[2] ?? process.env.VERIFY_BASE ?? 'http://localhost:3000';
const require = createRequire(import.meta.url);
const sharp = require('sharp');

let token = '';
const failures = [];
const passed = [];

async function call(path, { method = 'GET', body, form, expect = 200, note = '' } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}/api${path}`, { method, headers, body: payload });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const okStatus = response.status === expect;
  const okEnvelope = json === null || json.ok === true;
  if (okStatus && okEnvelope) {
    passed.push(`${method} ${path}${note ? ` · ${note}` : ''}`);
  } else {
    failures.push({
      endpoint: `${method} ${path}`,
      status: response.status,
      expected: expect,
      code: json?.error?.code,
      message: json?.error?.message ?? text.slice(0, 120),
    });
  }
  return json?.data;
}

const today = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(today.getTime() - n * 86_400_000));

console.log(`\n== 接口全量扫描 @ ${BASE} ==\n`);

/* ---------- 准备数据（尽量覆盖每个模块，让只读接口都有东西可查） ---------- */

const registered = await call('/auth/register', {
  method: 'POST',
  expect: 201,
  body: { email: `verify-${Date.now()}@example.com`, password: 'mending123', displayName: '接口扫描' },
  note: '注册',
});
token = registered.token;

const dict = await call('/dictionary', { note: '字典' });
const hole = dict.damageTypes.find((d) => d.code === 'hole');
const elbow = dict.partsFlat.find((p) => p.code === 'elbow_right');
const darning = dict.stitches.find((s) => s.code === 'darning_hand');

const garment = (
  await call('/garments', {
    method: 'POST',
    body: {
      name: '扫描用羊毛衫',
      category: 'sweater',
      materialPrimary: 'wool',
      knitOrWoven: 'knit',
      seasonTags: ['autumn', 'winter'],
      purchasePrice: 300,
      firstWearDate: daysAgo(25),
    },
  })
).garment;

const image = await sharp({
  create: { width: 800, height: 600, channels: 3, background: { r: 100, g: 100, b: 110 } },
})
  .jpeg()
  .toBuffer();
const photoForm = new FormData();
photoForm.append('file', new Blob([image], { type: 'image/jpeg' }), 'front.jpg');
photoForm.append('view', 'front');
const photo = (await call(`/garments/${garment.id}/photos`, { method: 'POST', expect: 201, form: photoForm, note: '上传照片' })).photo;

const annotation = (
  await call(`/photos/${photo.id}/annotations`, {
    method: 'POST',
    expect: 201,
    body: { annotations: [{ kind: 'point', geometry: { x: 0.4, y: 0.6 }, partId: elbow.id }] },
  })
).annotations[0];

const damage = (
  await call('/damage-events', {
    method: 'POST',
    expect: 201,
    body: {
      garmentId: garment.id,
      damageTypeId: hole.id,
      severity: 'moderate',
      partId: elbow.id,
      detectedAt: daysAgo(30),
      annotationIds: [annotation.id],
      locationUnknown: false,
    },
  })
).damage;

const fabricSource = (
  await call('/fabric-sources', {
    method: 'POST',
    expect: 201,
    body: {
      name: '扫描用余料',
      kind: 'original_scrap',
      materialPrimary: 'wool',
      inventory: { unit: 'cm', initialAmount: 120 },
    },
  })
).fabricSource;

const repair = (
  await call('/repairs', {
    method: 'POST',
    expect: 201,
    body: {
      damageEventId: damage.id,
      executedBy: 'self',
      stitchId: darning.id,
      startedAt: daysAgo(25),
      finishedAt: daysAgo(24),
    },
  })
).repair;

await call(`/repairs/${repair.id}/materials`, {
  method: 'POST',
  expect: 201,
  body: { fabricSourceId: fabricSource.id, amount: 20 },
});
await call(`/repairs/${repair.id}/change`, {
  method: 'PUT',
  body: {
    visibility: 'slight',
    colorMatch: 'close',
    stiffness: 'same',
    drapeChange: 'none',
    mobilityLimited: false,
    visibleFromOutside: false,
  },
});
await call(`/repairs/${repair.id}/start-observation`, { method: 'POST', body: {} });
await call(`/repairs/${repair.id}/worksheet`, { method: 'POST', note: '修补工单' });
await call('/wear-logs', { method: 'POST', expect: 201, body: { garmentId: garment.id, wornOn: daysAgo(10) } });
await call('/wear-logs', { method: 'POST', expect: 201, body: { garmentId: garment.id, wornOn: daysAgo(3) } });
await call('/wear-logs/batch', {
  method: 'POST',
  body: { logs: [{ garmentId: garment.id, wornOn: daysAgo(5), clientOpId: 'verify-op-1' }] },
});
await call('/reminder-rules/run-now', { method: 'POST', note: '手动扫描提醒' });

const shareLink = await call('/share-links', {
  method: 'POST',
  expect: 201,
  body: { scope: 'garment', garmentIds: [garment.id], expiresInHours: 24 },
});

const reminders = (await call('/reminders?scope=all&limit=50')).items;
const openReminder = reminders.find((r) => ['pending', 'notified'].includes(r.status));
if (openReminder) {
  await call(`/reminders/${openReminder.id}/snooze`, {
    method: 'POST',
    body: { snoozeUntil: iso(new Date(today.getTime() + 5 * 86_400_000)) },
    note: '顺延（验证 nextReminderExpireAt）',
  });
}

/* ---------- 只读端点全量扫描 ---------- */

const readEndpoints = [
  ['/healthz', '健康检查'],
  ['/auth/me', '当前用户'],
  ['/wardrobe', '衣橱总览'],
  ['/wardrobe/members', '成员'],
  ['/dictionary', '字典'],
  ['/activity-logs?limit=20', '操作日志'],
  ['/garments?page=1&pageSize=10', '衣物列表'],
  ['/garments?sort=health&includeRetired=true', '衣物列表（含退役）'],
  ['/garments?frequencyBand=high', '衣物列表（按频率）'],
  [`/garments/${garment.id}`, '衣物详情'],
  [`/garments/${garment.id}/timeline`, '时间线'],
  [`/garments/${garment.id}/lifetime-report`, '终身档案'],
  [`/garments/${garment.id}/wear-stats`, '穿着统计'],
  [`/garments/${garment.id}/annotations/orphans`, '草稿标记'],
  [`/garments/${garment.id}/photos`, '照片列表'],
  [`/photos/${photo.id}/annotations`, '照片标记'],
  ['/damage-events?limit=20', '破损列表'],
  ['/damage-events?open=true', '未终结破损'],
  [`/damage-events/${damage.id}`, '破损详情'],
  [`/damage-events/${damage.id}/recurrence-candidates`, '复发候选'],
  ['/repairs?limit=20', '修补列表'],
  [`/repairs/${repair.id}`, '修补详情'],
  [`/repairs/${repair.id}/comparison`, '前后对比'],
  ['/wear-logs?limit=20', '穿着记录'],
  [`/wear-logs/calendar?month=${iso(today).slice(0, 7)}`, '穿着日历'],
  ['/fabric-sources', '布料列表'],
  [`/fabric-sources/${fabricSource.id}/txns`, '库存流水'],
  [`/fabric-sources/${fabricSource.id}/usage`, '布料使用效果'],
  ['/reminders?scope=today&limit=20', '提醒（今天）'],
  ['/reminders?scope=overdue&limit=20', '提醒（逾期）'],
  ['/reminders?scope=upcoming&limit=20', '提醒（未来）'],
  ['/reminders?scope=done&limit=20', '提醒（已处理）'],
  ['/reminders?scope=expired&limit=20', '提醒（已失效）'],
  ['/reminders?scope=all&limit=50', '提醒（全部）'],
  ['/reminders/summary', '提醒角标'],
  ['/reminder-rules', '提醒规则'],
  ['/analytics/overview', '分析总览'],
  ['/analytics/by-material', '按材质'],
  ['/analytics/by-season', '按季节'],
  ['/analytics/by-frequency', '按频率'],
  ['/analytics/stitch-effectiveness', '针法效果'],
  ['/analytics/health-distribution', '健康分分布'],
  [`/analytics/garments/${garment.id}/health`, '单件健康分'],
  ['/analytics/wear-trend?months=12', '穿着趋势'],
  ['/share-links', '分享链接列表'],
  [`/share/${shareLink.token}`, '分享（访客视角）'],
  [`/share/${shareLink.token}/garment/${garment.id}`, '分享衣物（访客视角）'],
];

for (const [path, note] of readEndpoints) {
  await call(path, { note });
}

const csv = await fetch(`${BASE}/api/export/wardrobe.csv?dataset=repairs`, {
  headers: { authorization: `Bearer ${token}` },
});
csv.ok ? passed.push('GET /export/wardrobe.csv · CSV 导出') : failures.push({ endpoint: 'GET /export/wardrobe.csv', status: csv.status });

const markdown = await fetch(`${BASE}/api/export/garments/${garment.id}.md`, {
  headers: { authorization: `Bearer ${token}` },
});
markdown.ok ? passed.push('GET /export/garments/:id.md · Markdown 导出') : failures.push({ endpoint: 'GET /export/garments/:id.md', status: markdown.status });

for (const [path, note] of [
  [`/print/garment/${garment.id}?token=${encodeURIComponent(token)}`, '打印档案'],
  [`/print/repair-worksheet/${damage.id}?token=${encodeURIComponent(token)}`, '打印工单'],
]) {
  const response = await fetch(`${BASE}/api${path}`);
  const text = await response.text();
  response.ok && text.includes('<!doctype html')
    ? passed.push(`GET ${path.split('?')[0]} · ${note}`)
    : failures.push({ endpoint: `GET ${path.split('?')[0]}`, status: response.status, message: '未返回 HTML' });
}

/* ---------- 鉴权与边界（负面用例） ---------- */
const unauth = await fetch(`${BASE}/api/garments`);
unauth.status === 401 ? passed.push('无 token 访问受保护接口 → 401') : failures.push({ endpoint: 'GET /garments (匿名)', status: unauth.status, expected: 401 });

const badPhoto = await fetch(`${BASE}/api/photos/${photo.id}/file`);
badPhoto.status === 401 ? passed.push('图片接口匿名访问 → 401') : failures.push({ endpoint: 'GET /photos/:id/file (匿名)', status: badPhoto.status, expected: 401 });

const wrongTokenPhoto = await fetch(`${BASE}/api/photos/${photo.id}/file?token=not-a-token`);
wrongTokenPhoto.status === 401
  ? passed.push('图片接口伪造 token → 401')
  : failures.push({ endpoint: 'GET /photos/:id/file (伪造 token)', status: wrongTokenPhoto.status, expected: 401 });

const expiredShare = await fetch(`${BASE}/api/share/not-a-real-token`);
expiredShare.status === 401 || expiredShare.status === 410
  ? passed.push('分享链接 token 无效 → 401/410')
  : failures.push({ endpoint: 'GET /share/:token (无效)', status: expiredShare.status, expected: '401/410' });

/* ---------- 写操作补充扫描（放在只读扫描之后，避免影响上面的读取结果） ---------- */

await call(`/garments/${garment.id}`, {
  method: 'PATCH',
  body: { note: '接口扫描更新备注', storageLocation: '测试柜' },
  note: '更新衣物',
});
await call(`/garments/${garment.id}/washed`, { method: 'POST', body: {}, note: '记录清洗' });
await call(`/damage-events/${damage.id}/schedule`, {
  method: 'POST',
  body: { scheduledAt: daysAgo(-3) },
  note: '排期修补',
});
// 版本合并：先读当前版本，再按 baseVersion 更新；过期版本必须 409
const damageNow = await call(`/damage-events/${damage.id}`, { note: '读取破损当前版本' });
await call(`/damage-events/${damage.id}`, {
  method: 'PATCH',
  body: { description: '接口扫描更新描述', baseVersion: damageNow.damage.version },
  note: '按版本合并更新破损',
});
const staleDamage = await fetch(`${BASE}/api/damage-events/${damage.id}`, {
  method: 'PATCH',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ description: '过期版本的修改', baseVersion: 1 }),
});
const staleDamageJson = await staleDamage.json();
staleDamage.status === 409 && staleDamageJson?.error?.code === 'VERSION_CONFLICT'
  ? passed.push('PATCH /damage-events/:id (过期版本) → 409 VERSION_CONFLICT')
  : failures.push({ endpoint: 'PATCH /damage-events/:id (过期版本)', status: staleDamage.status, expected: 409 });
const repairNow = await call(`/repairs/${repair.id}`, { note: '读取修补当前版本' });
await call(`/repairs/${repair.id}`, {
  method: 'PATCH',
  body: { note: '接口扫描更新修补备注', baseVersion: repairNow.repair.version },
  note: '按版本合并更新修补',
});
await call(`/annotations/${annotation.id}`, {
  method: 'PATCH',
  body: { kind: 'point', geometry: { x: 0.41, y: 0.61 } },
  note: '调整标记坐标',
});
await call(`/fabric-sources/${fabricSource.id}/restock`, {
  method: 'POST',
  body: { amount: 30, note: '接口扫描补货' },
  note: '布料补货',
});
await call(`/fabric-sources/${fabricSource.id}/adjust`, {
  method: 'POST',
  body: { amount: 150, reason: '接口扫描盘点' },
  note: '布料盘点',
});

const customRule = await call('/reminder-rules', {
  method: 'POST',
  expect: 201,
  body: {
    name: '接口扫描自定义规则',
    triggerKind: 'custom',
    params: { mode: 'periodic', months: [5], message: '检查亚麻衣物' },
    scopeFilter: {},
    scheduleCron: '0 * * * *',
    channel: 'inapp',
    priority: 'low',
    isEnabled: true,
  },
  note: '新建自定义规则',
});
await call(`/reminder-rules/${customRule.rule.id}`, {
  method: 'PATCH',
  body: { isEnabled: false },
  note: '停用自定义规则',
});
await call(`/reminder-rules/${customRule.rule.id}`, { method: 'DELETE', note: '删除自定义规则' });

const builtinRules = (await call('/reminder-rules')).rules.filter((r) => r.isBuiltin);
if (builtinRules.length > 0) {
  await call(`/reminder-rules/${builtinRules[0].id}`, {
    method: 'PATCH',
    body: { isEnabled: false },
    note: '停用内置规则',
  });
  await call(`/reminder-rules/${builtinRules[0].id}`, {
    method: 'PATCH',
    body: { isEnabled: true },
    note: '重新启用内置规则',
  });
}

const openAfterScan = (await call('/reminders?scope=all&limit=50')).items.filter((r) =>
  ['pending', 'notified'].includes(r.status),
);
if (openAfterScan.length > 0) {
  await call(`/reminders/${openAfterScan[0].id}/complete`, {
    method: 'POST',
    body: { note: '接口扫描标记完成' },
    note: '提醒标记完成',
  });
}

await call(`/share-links/${shareLink.id}`, { method: 'DELETE', note: '撤销分享链接' });
await call('/wear-logs/batch', {
  method: 'POST',
  body: { logs: [{ garmentId: garment.id, wornOn: daysAgo(1), clientOpId: 'verify-op-2' }] },
  note: '批量补录（二次幂等）',
});

const wearLogs = (await call('/wear-logs?limit=50')).logs;
if (wearLogs.length > 0) {
  await call(`/wear-logs/${wearLogs[0].id}`, { method: 'DELETE', note: '删除一条穿着记录' });
}

const orphan = await call(`/photos/${photo.id}/annotations`, {
  method: 'POST',
  expect: 201,
  body: { annotations: [{ kind: 'rect', geometry: { x: 0.2, y: 0.2, w: 0.1, h: 0.1 } }] },
  note: '新建草稿标记',
});
await call(`/annotations/${orphan.annotations[0].id}`, { method: 'DELETE', note: '删除草稿标记' });

const loosePhotoForm = new FormData();
loosePhotoForm.append('file', new Blob([image], { type: 'image/jpeg' }), 'back.jpg');
loosePhotoForm.append('view', 'back');
const loosePhoto = (await call(`/garments/${garment.id}/photos`, { method: 'POST', expect: 201, form: loosePhotoForm })).photo;
await call(`/photos/${loosePhoto.id}`, { method: 'PATCH', body: { view: 'detail', note: '接口扫描' }, note: '修改照片信息' });
await call(`/photos/${loosePhoto.id}`, { method: 'DELETE', note: '删除未关联照片' });

// 退役 / 恢复：放在最后，因为它会改变衣物状态
await call(`/garments/${garment.id}/retire`, {
  method: 'POST',
  body: { disposition: 'rag', dispositionNote: '接口扫描' },
  note: '退役',
});
await call(`/garments/${garment.id}/restore`, { method: 'POST', note: '恢复在用' });

console.log(`通过 ${passed.length} 项`);
for (const item of passed) console.log(`  ✓ ${item}`);

if (failures.length > 0) {
  console.log(`\n失败 ${failures.length} 项：`);
  for (const failure of failures) {
    console.log(
      `  ✗ ${failure.endpoint} → ${failure.status}（期望 ${failure.expected ?? 200}）` +
        `${failure.code ? ` ${failure.code}` : ''}${failure.message ? ` ${failure.message}` : ''}`,
    );
  }
  process.exit(1);
}
console.log('\n全部接口正常\n');
