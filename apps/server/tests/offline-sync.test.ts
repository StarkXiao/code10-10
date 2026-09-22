/**
 * 离线工作流回归：
 *   1. 断网登记的破损/修补重放时按 clientOpId 幂等（重放几次都只建一条）
 *   2. 同一 clientOpId 并发重放不冒 500，也不会建出重复记录
 *   3. 多端编辑按记录版本合并：baseVersion 对得上才落库，对不上返回 409 + 服务器当前记录
 *   4. 服务端状态流转（登记修补等）也会推进版本号，让另一端的编辑能感知到变化
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const app = createApp();

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));

interface Account {
  token: string;
  auth: (req: request.Test) => request.Test;
  dictionary: Record<string, Array<Record<string, string>>>;
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
  return { token, auth: (req) => req.set('authorization', `Bearer ${token}`), dictionary };
}

let account: Account;

beforeAll(async () => {
  account = await register('离线同步');
});

async function createGarment(name: string): Promise<{ id: string }> {
  const response = await account
    .auth(request(app).post('/api/garments'))
    .send({ name, category: 'sweater', materialPrimary: 'wool', knitOrWoven: 'knit', seasonTags: ['winter'] })
    .expect(200);
  return response.body.data.garment;
}

async function createDamage(garmentId: string, extra: Record<string, unknown> = {}): Promise<{ id: string; version: number }> {
  const response = await account
    .auth(request(app).post('/api/damage-events'))
    .send({
      garmentId,
      damageTypeId: account.dictionary.damageTypes.find((d) => d.code === 'hole')!.id,
      severity: 'moderate',
      detectedAt: daysAgo(5),
      annotationIds: [],
      locationUnknown: true,
      locationNote: '离线同步用例',
      ...extra,
    })
    .expect(201);
  return response.body.data.damage;
}

describe('离线登记重放的幂等性', () => {
  it('同一个 clientOpId 的破损登记重放几次都只建一条', async () => {
    const garment = await createGarment('幂等破损衣物');
    const payload = {
      garmentId: garment.id,
      damageTypeId: account.dictionary.damageTypes.find((d) => d.code === 'seam_open')!.id,
      severity: 'minor',
      detectedAt: daysAgo(3),
      annotationIds: [],
      locationUnknown: true,
      locationNote: '重放用例',
      clientOpId: `op-damage-${Date.now()}`,
    };

    const first = await account.auth(request(app).post('/api/damage-events')).send(payload).expect(201);
    const second = await account.auth(request(app).post('/api/damage-events')).send(payload).expect(200);
    expect(second.body.meta.idempotent).toBe(true);
    expect(second.body.data.damage.id).toBe(first.body.data.damage.id);

    const count = await prisma.damageEvent.count({ where: { garmentId: garment.id } });
    expect(count).toBe(1);
  });

  it('同一个 clientOpId 的修补登记重放几次都只建一条（轮次不会虚增）', async () => {
    const garment = await createGarment('幂等修补衣物');
    const damage = await createDamage(garment.id);
    const payload = {
      damageEventId: damage.id,
      executedBy: 'self',
      stitchId: account.dictionary.stitches.find((s) => s.code === 'darning_hand')!.id,
      startedAt: daysAgo(2),
      finishedAt: daysAgo(1),
      clientOpId: `op-repair-${Date.now()}`,
    };

    const first = await account.auth(request(app).post('/api/repairs')).send(payload).expect(201);
    const second = await account.auth(request(app).post('/api/repairs')).send(payload).expect(200);
    expect(second.body.meta.idempotent).toBe(true);
    expect(second.body.data.repair.id).toBe(first.body.data.repair.id);

    const repairs = await prisma.repair.findMany({ where: { damageEventId: damage.id } });
    expect(repairs).toHaveLength(1);
    expect(repairs[0].round).toBe(1);
  });

  it('同一 clientOpId 并发重放：全部成功、只建一条、不冒 500', async () => {
    const garment = await createGarment('并发重放衣物');
    const payload = {
      garmentId: garment.id,
      damageTypeId: account.dictionary.damageTypes.find((d) => d.code === 'hole')!.id,
      severity: 'moderate',
      detectedAt: daysAgo(2),
      annotationIds: [],
      locationUnknown: true,
      locationNote: '并发重放',
      clientOpId: `op-race-${Date.now()}`,
    };
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => account.auth(request(app).post('/api/damage-events')).send(payload)),
    );
    expect(responses.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(responses.some((r) => r.status >= 500)).toBe(false);
    const ids = new Set(responses.map((r) => r.body.data.damage.id as string));
    expect(ids.size).toBe(1);
    expect(await prisma.damageEvent.count({ where: { garmentId: garment.id } })).toBe(1);
  });
});

describe('多端编辑按记录版本合并', () => {
  it('baseVersion 匹配才落库并推进版本；过期版本返回 409 与服务器当前记录', async () => {
    const garment = await createGarment('版本合并衣物');
    const damage = await createDamage(garment.id);
    expect(damage.version).toBe(1);

    const merged = await account
      .auth(request(app).patch(`/api/damage-events/${damage.id}`))
      .send({ severity: 'severe', description: '袖口破洞扩大', baseVersion: 1 })
      .expect(200);
    expect(merged.body.data.damage.version).toBe(2);
    expect(merged.body.data.damage.severity).toBe('severe');

    // 另一台设备还拿着 v1 编辑 → 冲突，响应里带服务器当前记录供对比
    const stale = await account
      .auth(request(app).patch(`/api/damage-events/${damage.id}`))
      .send({ severity: 'minor', baseVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.error.details.currentVersion).toBe(2);
    expect(stale.body.error.details.serverRecord.severity).toBe('severe');

    // 拿到最新版本号后可以「以我的为准」覆盖
    const overwritten = await account
      .auth(request(app).patch(`/api/damage-events/${damage.id}`))
      .send({ severity: 'minor', baseVersion: stale.body.error.details.currentVersion })
      .expect(200);
    expect(overwritten.body.data.damage.version).toBe(3);
    expect(overwritten.body.data.damage.severity).toBe('minor');
  });

  it('并发编辑同一版本：一个成功、其余 409，没有 500', async () => {
    const garment = await createGarment('并发编辑衣物');
    const damage = await createDamage(garment.id);

    const responses = await Promise.all(
      ['minor', 'severe', 'moderate'].map((severity) =>
        account.auth(request(app).patch(`/api/damage-events/${damage.id}`)).send({ severity, baseVersion: 1 }),
      ),
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    expect(responses.some((r) => r.status >= 500)).toBe(false);
    const final = await prisma.damageEvent.findUniqueOrThrow({ where: { id: damage.id } });
    expect(final.version).toBe(2);
  });

  it('不带 baseVersion 的旧客户端仍然能改（最后写入胜出），但版本照样推进', async () => {
    const garment = await createGarment('兼容旧客户端衣物');
    const damage = await createDamage(garment.id);
    const updated = await account
      .auth(request(app).patch(`/api/damage-events/${damage.id}`))
      .send({ description: '旧客户端的修改' })
      .expect(200);
    expect(updated.body.data.damage.version).toBe(2);
  });

  it('修补记录同样按版本合并', async () => {
    const garment = await createGarment('修补版本衣物');
    const damage = await createDamage(garment.id);
    const repair = (
      await account
        .auth(request(app).post('/api/repairs'))
        .send({
          damageEventId: damage.id,
          executedBy: 'self',
          stitchId: account.dictionary.stitches.find((s) => s.code === 'backstitch')!.id,
          startedAt: daysAgo(2),
          finishedAt: daysAgo(1),
        })
        .expect(201)
    ).body.data.repair;
    expect(repair.version).toBe(1);

    const merged = await account
      .auth(request(app).patch(`/api/repairs/${repair.id}`))
      .send({ note: '补记：用了双股线', baseVersion: 1 })
      .expect(200);
    expect(merged.body.data.repair.version).toBe(2);

    const stale = await account
      .auth(request(app).patch(`/api/repairs/${repair.id}`))
      .send({ note: '另一台设备的修改', baseVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.error.details.serverRecord.note).toBe('补记：用了双股线');
  });

  it('登记修补会推进破损记录的版本：另一端拿着旧版本编辑会收到冲突', async () => {
    const garment = await createGarment('状态流转版本衣物');
    const damage = await createDamage(garment.id);
    expect(damage.version).toBe(1);

    await account
      .auth(request(app).post('/api/repairs'))
      .send({
        damageEventId: damage.id,
        executedBy: 'shop',
        stitchId: account.dictionary.stitches.find((s) => s.code === 'backstitch')!.id,
        startedAt: daysAgo(2),
        finishedAt: daysAgo(1),
      })
      .expect(201);

    const stale = await account
      .auth(request(app).patch(`/api/damage-events/${damage.id}`))
      .send({ description: '基于旧版本的编辑', baseVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.error.details.currentVersion).toBe(2);
    expect(stale.body.error.details.serverRecord.status).toBe('repaired');
  });
});
