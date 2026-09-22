import { expect, test, type Page } from '@playwright/test';

/**
 * 端到端闭环（真实浏览器 + 真实后端）：
 *   注册 → 建档 → 上传照片 → 在照片上标记位置 → 保存标记 → 列表缩略图可见 → 打点穿着 → 总览/提醒中心
 *
 * 同时收集浏览器控制台里的 [Vue warn]，避免"页面能跑但一直在报警"的隐蔽问题。
 */

/** 一张 64×64 的 PNG（内联，避免测试依赖外部素材） */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAj0lEQVR4nO3PAQkAABDCQNMZ4hMv1scQQbgAmzhXU7yADbia4gVswNUUL2ADrqZ4ARtwNcUL2ICrKV7ABlxN8QI24GqKF7ABV1O8gA24muIFbMDVFC9gA66meAEbcDXFC9iAqylewAZcTfECNuBqihewAVdTvIANuJriBWzA1RQvYAOupngBG3A1xQvYgKs9IMiBSzssoOoAAAAASUVORK5CYII=';

/** 每个用例用独立账号，避免互相污染 */
function uniqueEmail(): string {
  return `e2e-${Date.now()}-${Math.floor(Math.random() * 1000)}@example.com`;
}

const consoleProblems: string[] = [];

test.beforeEach(async ({ page }) => {
  consoleProblems.length = 0;
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'warning' && text.includes('[Vue warn]')) consoleProblems.push(text);
    // 离线用例会故意断开网络，这类"资源加载失败"的浏览器噪音不算 bug
    const expectedOfflineNoise = /ERR_INTERNET_DISCONNECTED|Failed to load resource/u.test(text);
    if (message.type() === 'error' && !text.includes('favicon') && !expectedOfflineNoise) {
      consoleProblems.push(`[console.error] ${text}`);
    }
  });
  page.on('pageerror', (error) => consoleProblems.push(`[pageerror] ${error.message}`));
});

test.afterEach(() => {
  expect(consoleProblems, `浏览器控制台出现异常：\n${consoleProblems.join('\n')}`).toEqual([]);
});

async function register(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByRole('tab', { name: '注册' }).click();
  await page.getByLabel('称呼').fill('端到端测试');
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill('mending123');
  await page.getByRole('button', { name: '注册并创建衣橱' }).click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByText('衣橱总览')).toBeVisible();
}

async function createGarment(page: Page, name: string): Promise<string> {
  await page.getByRole('button', { name: '建档' }).first().click();
  await expect(page.getByText('新建衣物档案')).toBeVisible();
  await page.getByLabel('名称').fill(name);
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '创建档案' }).click();
  await expect(page.getByText('档案已创建')).toBeVisible();
  await page.getByRole('button', { name: '进入档案' }).click();
  await expect(page.getByText(name)).toBeVisible();
  await expect(page.getByText(/G-\d{4}-\d{4}/u).first()).toBeVisible();
  const id = page.url().split('/garments/')[1]?.split(/[?#]/u)[0] ?? '';
  expect(id).not.toBe('');
  return id;
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill('mending123');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/$/u);
}

/** 上传一张照片（后续标位置需要） */
async function uploadPhoto(page: Page): Promise<void> {
  await page.setInputFiles('input[type=file]', {
    name: 'front.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_BASE64, 'base64'),
  });
  await expect(page.getByText(/已上传「/u)).toBeVisible();
}

/** 在画布中心点一个标记 */
async function markOnCanvas(page: Page): Promise<void> {
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(1000);
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

test.describe('衣物修补日志 · 主链路', () => {
  test('注册 → 建档 → 上传照片 → 在图上标记 → 保存标记 → 列表缩略图可见', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, email);
    const garmentId = await createGarment(page, '端到端羊毛衫');

    // 上传照片（这一步会验证 PhotoUploader 真的发出了上传请求）
    await page.setInputFiles('input[type=file]', {
      name: 'front.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_BASE64, 'base64'),
    });
    await expect(page.getByText(/已上传「正面」/u)).toBeVisible();
    await expect(page.getByText('照片与标记')).toBeVisible();

    // 打开标记编辑器，点一下画布创建标记，再保存
    await page.getByRole('button', { name: '打开标记编辑器' }).click();
    await expect(page).toHaveURL(new RegExp(`/garments/${garmentId}/annotate`, 'u'));
    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible();
    // 等图片解码完成再点击
    await expect(page.getByText(/缩放 \d+%/u)).toBeVisible();
    await page.waitForTimeout(1200);
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);

    const saveButton = page.getByRole('button', { name: /保存 1 个新标记/u });
    await expect(saveButton).toBeVisible();
    await saveButton.click();
    await expect(page.getByText(/已保存 1 个标记/u)).toBeVisible();
    await expect(page.getByText('待关联', { exact: true })).toBeVisible();

    // 衣物列表的缩略图必须真的能加载（图片接口需要鉴权，src 必须带 token）
    await page.getByRole('menuitem', { name: '衣物' }).click();
    const thumb = page.locator('.grid-cards img').first();
    await expect(thumb).toBeVisible();
    await expect
      .poll(async () => thumb.evaluate((element) => (element as HTMLImageElement).naturalWidth), {
        message: '列表缩略图应能真正解码（naturalWidth > 0）',
      })
      .toBeGreaterThan(0);
  });

  test('登录 → 打点穿着 → 总览与提醒中心可用', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, email);
    await createGarment(page, '打点测试衣物');

    await page.getByRole('button', { name: '今天穿了' }).click();
    await expect(page.getByText(/已记录今天穿着|今天已经记过一次/u)).toBeVisible();

    await page.getByRole('menuitem', { name: '总览' }).click();
    await expect(page.getByText('衣橱总览')).toBeVisible();
    await expect(page.getByText('累计穿着')).toBeVisible();

    await page.getByRole('menuitem', { name: /提醒/u }).click();
    await expect(page.getByText('提醒中心')).toBeVisible();
    await expect(page.getByRole('button', { name: '立刻检查' })).toBeVisible();
  });

  test('退出后重新登录，仍能看到之前的衣物', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, email);
    await createGarment(page, '登录复用测试');
    await login(page, email);

    await page.getByRole('menuitem', { name: '衣物' }).click();
    await expect(page.getByText('登录复用测试')).toBeVisible();
    await expect(page.getByText(/每穿成本/u).first()).toBeVisible();
  });

  test('破损 → 修补 → 复检：完整闭环在浏览器里走得通', async ({ page }) => {
    await register(page, uniqueEmail());
    await createGarment(page, '闭环测试羊毛衫');
    await uploadPhoto(page);

    // 1. 登记破损：选类型 → 在照片上标位置 → 提交
    await page.getByRole('button', { name: '登记破损' }).click();
    await expect(page.getByText('登记破损').first()).toBeVisible();
    await page.getByRole('button', { name: '下一步：标位置' }).click();
    await markOnCanvas(page);
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByLabel('描述').fill('右肘磨出一个小洞');
    await page.getByRole('button', { name: '提交登记' }).click();

    // 落在破损详情页
    await expect(page).toHaveURL(/\/damage\//u);
    await expect(page.getByText(/D\d{2}/u).first()).toBeVisible();
    await expect(page.getByText(/待修/u).first()).toBeVisible();

    // 2. 登记修补：针法/执行方 → 跳过用料 → 填写修补后变化并进入观察期
    await page.getByRole('button', { name: '登记修补' }).click();
    await page.getByRole('button', { name: '创建修补记录' }).click();
    await expect(page.getByText(/已登记第 1 轮修补/u)).toBeVisible();

    await page.getByRole('button', { name: '下一步' }).click();
    await expect(page.getByText(/修补后的变化是这套档案最有价值的部分/u)).toBeVisible();
    await page.getByLabel('穿着体感').fill('穿上没有异物感，活动正常');
    await page.getByRole('button', { name: '保存并进入观察期' }).click();

    // 落在修补详情页，且进入观察期
    await expect(page).toHaveURL(/\/repairs\//u);
    await expect(page.getByText(/观察期/u).first()).toBeVisible();
    await expect(page.getByText('穿着体感', { exact: true })).toBeVisible();
    await expect(page.getByText('穿上没有异物感，活动正常')).toBeVisible();

    // 3. 复检：结论良好 + 闭环结束
    await page.getByRole('button', { name: '填写复检' }).click();
    await expect(page.getByText('修补复检')).toBeVisible();
    await page.getByLabel('复检说明').fill('织补处平整，拉扯也没有松动');
    await page.getByRole('button', { name: '提交复检' }).click();
    // 观察期还没走完：服务端会拦一次，确认后才允许提前复检
    await expect(page.getByText('提前复检', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '仍然提交' }).click();

    // 回到衣物档案，破损已经是「复检通过」
    await expect(page).toHaveURL(/\/garments\//u);
    await expect(page.getByText('复检通过').first()).toBeVisible();
  });

  test('所有页面都能正常打开（数据/图表/字典页无运行时错误）', async ({ page }) => {
    await register(page, uniqueEmail());
    await createGarment(page, '页面冒烟衣物');

    const pages: Array<[string, string]> = [
      ['/', '衣橱总览'],
      ['/garments', '衣物档案'],
      ['/wear', '穿着记录'],
      ['/fabric', '布料来源与库存'],
      ['/reminders', '提醒中心'],
      ['/analytics', '长期使用报告'],
      ['/settings', '设置'],
    ];
    for (const [path, heading] of pages) {
      await page.goto(path);
      await expect(page.getByText(heading).first(), `${path} 应能正常渲染`).toBeVisible();
    }

    // 长期使用页的图表要真的画出来（ECharts 初始化失败时控制台会报错）
    await page.goto('/analytics');
    await expect(page.locator('canvas').first()).toBeVisible();
    // Element Plus 的 radio-button 真正的 input 被 label 覆盖，点文字更稳
    await page.getByText('按季节', { exact: true }).click();
    await page.getByText('按穿着频率', { exact: true }).click();
    await expect(page.getByText('针法效果榜（针法 × 材质）')).toBeVisible();

    // 设置页的四个页签都要能打开
    await page.goto('/settings');
    for (const [tabName, marker] of [
      ['提醒规则', '规则列表'],
      ['分享', '生成只读分享链接'],
      ['字典', '针法库'],
      ['数据与审计', '导出与备份'],
    ] as Array<[string, string]>) {
      await page.getByRole('tab', { name: tabName }).click();
      await expect(page.getByText(marker, { exact: false }).first(), `设置页「${tabName}」应能打开`).toBeVisible();
    }
  });

  test('布料来源建档 + 只读分享链接（裁缝视角）可用', async ({ page, context }) => {
    await register(page, uniqueEmail());
    await createGarment(page, '分享测试大衣');
    await uploadPhoto(page);

    // 布料建档
    await page.goto('/fabric');
    await page.getByRole('button', { name: '登记布料来源' }).first().click();
    await page.getByLabel('名称').fill('旧牛仔裤拆的布');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText(/已登记布料来源与库存/u)).toBeVisible();
    await expect(page.getByText('旧牛仔裤拆的布')).toBeVisible();
    await expect(page.getByText(/剩余 100/u)).toBeVisible();

    // 生成只读分享链接并访问（模拟裁缝/干洗店视角）
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/settings');
    await page.getByRole('tab', { name: '分享' }).click();
    await page.locator('.el-select').filter({ hasText: '选择要分享的衣物' }).first().click();
    await page.locator('.el-select-dropdown__item').filter({ hasText: '分享测试大衣' }).first().click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '生成并复制链接' }).click();
    await expect(page.getByText(/已生成只读链接/u)).toBeVisible();

    const shareUrl = await page.evaluate(() => navigator.clipboard.readText());
    expect(shareUrl).toContain('/share/');

    // 访客视角：能看到衣物与照片，且页面没有登录态也能渲染
    const guestContext = await context.browser()!.newContext({ locale: 'zh-CN' });
    const guest = await guestContext.newPage();
    await guest.goto(shareUrl);
    await expect(guest.getByText('只读档案')).toBeVisible();
    // 分享页是独立只读视图：不应出现登录后的主导航
    await expect(guest.getByText('长期使用')).toHaveCount(0);
    await expect(guest.locator('body')).toContainText('分享测试大衣');
    await expect(guest.getByText('照片与标记位置')).toBeVisible();
    const photo = guest.locator('img').first();
    await expect
      .poll(async () => photo.evaluate((element) => (element as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    await guestContext.close();
  });

  test('断网打点：先入离线队列，恢复网络后自动同步', async ({ page, context }) => {
    await register(page, uniqueEmail());
    await createGarment(page, '离线测试衣物');

    await context.setOffline(true);
    await page.getByRole('button', { name: '今天穿了' }).click();
    await expect(page.getByText(/离线队列|离线状态/u).first()).toBeVisible();
    await expect(page.getByText(/离线待同步/u).first()).toBeVisible();

    await context.setOffline(false);
    // 恢复网络后由 online 事件触发同步，队列清空即表示已写入服务端
    await expect(page.getByText(/离线待同步/u)).toHaveCount(0, { timeout: 20_000 });

    // 同步结果要真的落库：档案页的穿着次数变成 1
    await page.reload();
    await expect(page.getByText('穿着次数').first()).toBeVisible();
    await expect(page.locator('body')).toContainText('1 次');
  });

  test('断网登记破损：先落本机，联网后同步入库', async ({ page, context }) => {
    await register(page, uniqueEmail());
    const garmentId = await createGarment(page, '离线破损衣物');

    await context.setOffline(true);
    // 登记破损：没有照片时走「位置不便标记」路径（离线无法上传标记）
    await page.getByRole('button', { name: '登记破损' }).click();
    await page.getByRole('button', { name: '下一步：标位置' }).click();
    await page.getByRole('checkbox', { name: '位置不便标记（例如已经送去店里）' }).check();
    await page.getByPlaceholder('说明一下位置，例如：左袖口内侧，送修时被师傅带走了').fill('离线测试：左肘内侧');
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByLabel('描述').fill('断网时发现的小洞');
    await page.getByRole('button', { name: '提交登记' }).click();

    // 回到档案页，顶栏显示离线待同步
    await expect(page).toHaveURL(new RegExp(`/garments/${garmentId}`, 'u'));
    await expect(page.getByText(/离线待同步 1/u).first()).toBeVisible();

    await context.setOffline(false);
    // 自动同步成功：队列清空，并出现成功提示
    await expect(page.getByText(/离线待同步/u)).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByText(/离线记录已同步/u)).toBeVisible();

    // 真的落库：档案页能看到破损记录
    await page.reload();
    await expect(page.getByText(/断网时发现的小洞|D\d{2}/u).first()).toBeVisible();
  });

  test('同步冲突：顶栏高亮并在同步中心说明合并结果', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, email);
    await createGarment(page, '冲突提示衣物');

    const token = await page.evaluate(() => localStorage.getItem('gml.token') ?? '');

    // 用 API 取衣物 / 字典，然后在线建一条破损，再把它改到 v2（模拟"别的端先改过"）
    const { garmentId, damageId, stitchId } = await page.evaluate(async (authToken) => {
      const headers = { authorization: `Bearer ${authToken}` };
      const garments = await (await fetch('/api/garments?pageSize=1', { headers })).json();
      const gid = garments.data.items[0].id as string;
      const dict = await (await fetch('/api/dictionary', { headers })).json();
      const created = await (
        await fetch('/api/damage-events', {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            garmentId: gid,
            damageTypeId: dict.data.damageTypes.find((d: { code: string }) => d.code === 'hole').id,
            severity: 'moderate',
            detectedAt: new Date().toISOString().slice(0, 10),
            annotationIds: [],
            locationUnknown: true,
            locationNote: '冲突测试：右肘',
          }),
        })
      ).json();
      const did = created.data.damage.id as string;
      // 另一台设备先把严重度改成 severe → v2
      await fetch(`/api/damage-events/${did}`, {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ severity: 'severe', expectedVersion: 1 }),
      });
      return { garmentId: gid, damageId: did, stitchId: dict.data.stitches[0].id as string };
    }, token);

    // 往本地塞一条基于 v1 的离线修补（模拟断网设备重连后同步）
    await page.evaluate(
      ({ id, stitchId: sid }) => {
        const today = new Date().toISOString().slice(0, 10);
        const queue = [
          {
            id: `op-conflict-${Date.now()}`,
            kind: 'repair-create',
            payload: {
              damageEventId: id,
              executedBy: 'self',
              stitchId: sid,
              stitchSecondaryIds: [],
              startedAt: today,
              finishedAt: today,
              reuseOriginalFabric: false,
            },
            baseDamageVersion: 1,
            summary: '冲突提示衣物 · 离线修补',
            createdAt: Date.now(),
            attempts: 0,
          },
        ];
        localStorage.setItem('gml.offlineQueue.v2', JSON.stringify(queue));
      },
      { id: damageId, stitchId },
    );

    await page.goto(`/garments/${garmentId}`);
    await expect(page.getByText(/离线待同步 1/u).first()).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    // 冲突结果：顶栏出现"同步冲突"标签
    await expect(page.getByText(/同步冲突 1/u).first()).toBeVisible({ timeout: 20_000 });

    // 打开同步中心，能看到合并结果说明，并可跳到最新记录
    await page.getByText(/同步冲突 1/u).first().click();
    await expect(page.getByText('同步冲突：修补登记未按你的版本保存')).toBeVisible();
    await expect(page.getByText(/服务端已经是 v2/u)).toBeVisible();
    await page.getByRole('button', { name: '打开最新记录核对' }).click();
    await expect(page).toHaveURL(/\/damage\//u);
  });
});
