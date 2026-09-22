/**
 * 离线工作流（项目文档 F22）：
 *   1. 断网时登记的破损 / 修补 / 穿着先落本地（客户端队列），联网后整批 /api/sync 提交
 *   2. clientOpId 幂等：同一批操作重放 / 多端同时同步，不会造出重复记录
 *   3. 多端并发按记录版本合并：离线期间记录被别的端改过 → 409/conflict，服务端保留新版本，
 *      冲突结果逐条回报，由前端提示用户去合并（不静默覆盖）
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

const app = createApp();

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));

interface Account {
  token: string;
  auth: (req: request.Test) => request.Test;
  dictionary: {
    damageTypes: Array<Record<string, string>>;
    stitches: Array<Record<string, string>>;
  };
}

async function register(label: string): Promise<Account> {
  const slug = label.replace(/[^a-zA-Z0-9]/gu, '') || 'user';
  const registered = await request(app)
    .post('/api/auth/register')
    .send({
      email: `${slug}-${Date.now()}-${Math.floor(Math.random() * 1000)}@example.com`,
      password: 'mending123',
      displayName: label,
    })
    .expect(201);
  const token = registered.body.data.token as string;
  const dictionary = (
    await request(app).get('/api/dictionary').set('authorization', `Bearer ${token}`).expect(200)
  ).body.data;
  return {
    token,
    auth: (req) => req.set('authorization', `Bearer ${token}`),
    dictionary,
  };
}

async function makeGarment(account: Account, name: string) {
  const res = await account.auth(request(app).post('/api/garments')).send({
    name,
    category: 'sweater',
    materialPrimary: 'wool',
    knitOrWoven: 'knit',
    seasonTags: ['winter'],
  });
  return res.body.data.garment as { id: string; name: string };
}

function damagePayload(garmentId: string, account: Account, extra: Record<string, unknown> = {}) {
  return {
    garmentId,
    damageTypeId: account.dictionary.damageTypes.find((d) => d.code === 'hole')!.id,
    severity: 'moderate',
    detectedAt: daysAgo(2),
    annotationIds: [],
    locationUnknown: true,
    locationNote: '离线测试：袖口内侧',
    ...extra,
  };
}

let account: Account;

beforeAll(async () => {
  account = await register('离线同步');
});

describe('POST /api/sync 离线批量同步', () => {
  it('一批混提穿着/破损/修补：全部成功并回报版本号', async () => {
    const garment = await makeGarment(account, '离线混提衣物');

    const wearOpId = `op-wear-${Date.now()}`;
    const damageOpId = `op-damage-${Date.now()}`;

    // 先提穿着 + 破损
    const first = await account
      .auth(request(app).post('/api/sync'))
      .send({
        ops: [
          { opId: wearOpId, kind: 'wear-log', payload: { garmentId: garment.id, wornOn: daysAgo(1) } },
          { opId: damageOpId, kind: 'damage-create', payload: damagePayload(garment.id, account) },
        ],
      })
      .expect(200);
    expect(first.body.data.synced).toBe(2);
    expect(first.body.data.results.map((r: { status: string }) => r.status)).toEqual(['ok', 'ok']);
    const damageResult = first.body.data.results[1];
    expect(damageResult.entityType).toBe('damage_event');
    expect(damageResult.version).toBe(1);
    const damageId = damageResult.entityId as string;

    // 再用同一批 opId 重放（模拟断网重试 / 两台设备同时同步）：幂等，不造重复
    const replay = await account
      .auth(request(app).post('/api/sync'))
      .send({
        ops: [
          { opId: wearOpId, kind: 'wear-log', payload: { garmentId: garment.id, wornOn: daysAgo(1) } },
          { opId: damageOpId, kind: 'damage-create', payload: damagePayload(garment.id, account) },
        ],
      })
      .expect(200);
    expect(replay.body.data.results.map((r: { status: string }) => r.status)).toEqual(['duplicate', 'duplicate']);
    expect(replay.body.data.synced).toBe(0);
    expect(replay.body.data.duplicates).toBe(2);

    // 库里确实只有一条破损
    const list = await account
      .auth(request(app).get('/api/damage-events'))
      .query({ garmentId: garment.id })
      .expect(200);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0].id).toBe(damageId);

    // 修补也走同步：成功，破损版本因登记修补而 +1
    const repairOpId = `op-repair-${Date.now()}`;
    const repairRes = await account
      .auth(request(app).post('/api/sync'))
      .send({
        ops: [
          {
            opId: repairOpId,
            kind: 'repair-create',
            payload: {
              damageEventId: damageId,
              executedBy: 'self',
              stitchId: account.dictionary.stitches.find((s) => s.code === 'darning_hand')!.id,
              startedAt: daysAgo(1),
              finishedAt: iso(new Date()),
            },
            expectedDamageVersion: 1,
          },
        ],
      })
      .expect(200);
    expect(repairRes.body.data.results[0].status).toBe('ok');
    expect(repairRes.body.data.results[0].version).toBe(1);
  });

  it('业务错误逐条标记 rejected，不阻塞同批其他记录', async () => {
    const garment = await makeGarment(account, '离线拒绝衣物');

    // 先退役衣物
    await account
      .auth(request(app).post(`/api/garments/${garment.id}/retire`))
      .send({ disposition: 'donate' })
      .expect(200);

    const goodGarment = await makeGarment(account, '离线正常衣物');
    const res = await account
      .auth(request(app).post('/api/sync'))
      .send({
        ops: [
          // 退役衣物上登记破损 → rejected
          {
            opId: `op-bad-${Date.now()}`,
            kind: 'damage-create',
            payload: damagePayload(garment.id, account),
          },
          // 正常衣物的穿着打点 → ok
          {
            opId: `op-good-${Date.now()}`,
            kind: 'wear-log',
            payload: { garmentId: goodGarment.id, wornOn: daysAgo(1) },
          },
        ],
      })
      .expect(200);

    const rejected = res.body.data.results.find((r: { status: string }) => r.status === 'rejected');
    const ok = res.body.data.results.find((r: { status: string }) => r.status === 'ok');
    expect(rejected).toBeTruthy();
    expect(rejected.errorCode).toBe('GARMENT_RETIRED');
    expect(ok).toBeTruthy();
    expect(ok.entityType).toBe('wear_log');
  });
});

describe('多端并发：按记录版本合并', () => {
  it('离线期间破损被其他端修改，旧版本修补提交 → conflict，并回传双方版本', async () => {
    const garment = await makeGarment(account, '版本冲突衣物');

    // 设备 A 离线前看到破损 v1（直接走在线接口建好）
    const damage = (
      await account
        .auth(request(app).post('/api/damage-events'))
        .send(damagePayload(garment.id, account))
    ).body.data.damage;
    expect(damage.version).toBe(1);

    // 设备 B（或另一会话）先把严重度改了 → v2
    const patched = await account
      .auth(request(app).patch(`/api/damage-events/${damage.id}`))
      .send({ severity: 'severe', expectedVersion: 1 })
      .expect(200);
    expect(patched.body.data.damage.version).toBe(2);

    // 设备 A 拿着 expectedDamageVersion=1 的离线修补来同步 → conflict
    const res = await account
      .auth(request(app).post('/api/sync'))
      .send({
        ops: [
          {
            opId: `op-stale-${Date.now()}`,
            kind: 'repair-create',
            payload: {
              damageEventId: damage.id,
              executedBy: 'self',
              stitchId: account.dictionary.stitches.find((s) => s.code === 'backstitch')!.id,
              startedAt: daysAgo(1),
              finishedAt: iso(new Date()),
            },
            expectedDamageVersion: 1,
          },
        ],
      })
      .expect(200);
    const result = res.body.data.results[0];
    expect(result.status).toBe('conflict');
    expect(result.errorCode).toBe('VERSION_CONFLICT');
    expect(result.conflict.currentVersion).toBe(2);
    expect(result.conflict.expectedVersion).toBe(1);
    expect(result.conflict.entityId).toBe(damage.id);
    // 冲突的修补没有落库
    const repairs = await account
      .auth(request(app).get('/api/repairs'))
      .query({ damageEventId: damage.id })
      .expect(200);
    expect(repairs.body.data.items).toHaveLength(0);

    // 用户在最新版本上核对后重新提交（expectedDamageVersion=2）→ 成功
    const retry = await account
      .auth(request(app).post('/api/sync'))
      .send({
        ops: [
          {
            opId: `op-fresh-${Date.now()}`,
            kind: 'repair-create',
            payload: {
              damageEventId: damage.id,
              executedBy: 'self',
              stitchId: account.dictionary.stitches.find((s) => s.code === 'backstitch')!.id,
              startedAt: daysAgo(1),
              finishedAt: iso(new Date()),
            },
            expectedDamageVersion: 2,
          },
        ],
      })
      .expect(200);
    expect(retry.body.data.results[0].status).toBe('ok');
  });

  it('破损 PATCH 携带过期 expectedVersion → 409 VERSION_CONFLICT 且不覆盖新数据', async () => {
    const garment = await makeGarment(account, '编辑冲突衣物');
    const damage = (
      await account
        .auth(request(app).post('/api/damage-events'))
        .send(damagePayload(garment.id, account, { description: '原始描述' }))
    ).body.data.damage;

    // 第一笔修改成功 → v2
    await account
      .auth(request(app).patch(`/api/damage-events/${damage.id}`))
      .send({ severity: 'severe', expectedVersion: 1 })
      .expect(200);

    // 另一笔基于 v1 的修改 → 409，details 里带当前值，供客户端展示合并
    const conflict = await account
      .auth(request(app).patch(`/api/damage-events/${damage.id}`))
      .send({ description: '离线编辑的描述', expectedVersion: 1 })
      .expect(409);
    expect(conflict.body.error.code).toBe('VERSION_CONFLICT');
    expect(conflict.body.error.details.currentVersion).toBe(2);
    expect(conflict.body.error.details.current.severity).toBe('severe');

    // 服务端数据仍是先到的修改
    const detail = await account.auth(request(app).get(`/api/damage-events/${damage.id}`)).expect(200);
    expect(detail.body.data.damage.severity).toBe('severe');
    expect(detail.body.data.damage.description).toBe('原始描述');
    expect(detail.body.data.damage.version).toBe(2);
  });

  it('修补 PATCH 携带过期 expectedVersion → 409', async () => {
    const garment = await makeGarment(account, '修补冲突衣物');
    const damage = (
      await account
        .auth(request(app).post('/api/damage-events'))
        .send(damagePayload(garment.id, account))
    ).body.data.damage;
    const repair = (
      await account
        .auth(request(app).post('/api/repairs'))
        .send({
          damageEventId: damage.id,
          executedBy: 'self',
          stitchId: account.dictionary.stitches.find((s) => s.code === 'backstitch')!.id,
          startedAt: daysAgo(1),
          finishedAt: iso(new Date()),
        })
    ).body.data.repair;
    expect(repair.version).toBe(1);

    await account
      .auth(request(app).patch(`/api/repairs/${repair.id}`))
      .send({ durationMinutes: 30, expectedVersion: 1 })
      .expect(200);

    const stale = await account
      .auth(request(app).patch(`/api/repairs/${repair.id}`))
      .send({ note: '另一台设备离线写的备注', expectedVersion: 1 })
      .expect(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.error.details.currentVersion).toBe(2);
  });
});
