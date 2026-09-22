# 衣物修补日志（garment-mending-log）

给每一件真实穿在身上的衣服建一份从购入到退役的维修档案：破损在**照片上的哪个位置**、用了**什么针法**、补丁布**从哪来**、补完之后**穿起来有什么变化**；并按**材质 / 季节 / 穿着频率**三个维度回答一个具体问题——

> **这件衣服还能穿多久？下一件该买什么材质？哪种针法在哪种布料上真的扛得住？**

需求与设计基线见 [`../项目文档.md`](../项目文档.md)。

---

## 它解决什么

修衣服这件事会重复发生，但经验从不沉淀：手机相册只有几张拍糊的破洞照片，"这个点在右肘"不可查询；补完之后没人回访，三个月后又破了也想不起上次用的什么线。

这个项目把「**破损 → 修补 → 穿着体验 → 复检 → 复发/退役**」做成一条连续、可统计、带空间位置的数据链。

---

## 闭环长什么样

```
拍照片 → 在图上标出破损位置（归一化坐标）→ 登记破损
   ↓
登记修补：针法 + 布料来源 + 耗时费用
   ↓
记录「修补后变化」：痕迹 / 颜色 / 手感 / 尺寸 / 体感（必填）
   ↓
进入观察期（自补 14 天、送修 7 天）
   ↓
系统到点提醒复检（SSE 推送 + 站内待办）
   ├── 良好/尚可 → 闭环收口（破损 resolved）
   ├── 不合格 → 返工（生成返工任务，回到修补流程）
   └── 不可修 → 退役（必填处置方式）
   ↓
同一位置再破 → 识别为「复发」并串成链条 → 计入复修率 / 修补寿命
   ↓
按材质 / 季节 / 频率聚合 → 结论卡片 → 反馈到下一次选材与针法选择
```

**没有断头路**：破损事件只有 `复检通过 / 不可修 / 已取消` 三个出口；提醒都有 `expire_at`，超时自动失效；退役时未完成的待办一并失效。详见项目文档第 6 章「闭环自检表」。

---

## 快速开始

环境要求：**Node.js ≥ 20.11**（开发用 Node 24 验证通过），npm ≥ 10。不需要安装数据库。

```bash
# 1. 安装依赖（npm workspaces，一次装齐前后端）
npm install

# 2. 环境变量（默认值开箱即用）
cp .env.example .env

# 3. 建表 + 写入字典基线（针法/破损类型/材质/护理规则/部位树，不含任何示例业务数据）
npm run db:migrate
npm run db:seed

# 4. 同时启动前后端
npm run dev          # 前端 http://localhost:5173，API http://localhost:3000
```

打开 <http://localhost:5173>，注册账号（会自动创建衣橱与 9 条内置提醒规则），然后建第一件衣物。

> 端口被占用时改 `.env` 里的 `PORT`，并同步调整 `apps/web/vite.config.ts` 的代理目标
> （或直接 `VITE_API_TARGET=http://localhost:3020 npm run dev:web`）。

### 生产模式（单端口）

```bash
npm run build     # 构建前端
npm start         # Express 同时托管前端静态文件与 API，只暴露 3000 端口
```

### 容器

```bash
docker compose up -d        # http://localhost:3100
```

---

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 前后端一起跑（开发） |
| `npm run build` / `npm start` | 构建并以单端口运行 |
| `npm run db:migrate` | 建表/更新表结构，并生成 `prisma/migrations/0001_init/migration.sql` 快照 |
| `npm run db:seed` | 写入/更新字典基线（幂等） |
| `npm test` | 单元测试 + 闭环集成测试（独立测试库，不碰开发数据） |
| `npm run test:e2e` | Playwright 端到端（首次需 `npx playwright install chromium`） |
| `npm run verify:api` | 接口全量扫描：真实打一遍所有读写端点（约 100 项），页面 500 这类问题一眼可见 |
| `npm run reminders:run` | 手动跑一次提醒扫描 |
| `npm run backup` | 全量备份（数据库 + 照片 + JSON）→ `apps/server/data/backup/*.zip` |
| `npm run restore -- <zip>` | 从备份恢复（自动留 `.before-restore.bak`） |
| `npm run verify:media` | 校验每张照片 sha256 与数据库记录是否一致 |
| `node apps/server/scripts/smoke.mjs http://localhost:3000` | 真实 HTTP 闭环冒烟（29 项断言，可对着任意已启动服务跑） |

---

## 目录结构

```text
origin/
├─ packages/shared/            # 前后端共享：枚举与中文标签、统计口径、坐标换算、Zod 校验
│  └─ src/{enums,metrics,geometry,schemas}.ts
├─ apps/server/                # Node.js + Express + Prisma + SQLite
│  ├─ prisma/schema.prisma     # 24 张表的数据模型
│  ├─ prisma/seed.ts           # 字典基线（针法/破损/材质/护理/部位）
│  ├─ scripts/                 # migrate / backup / restore / verify-media / smoke
│  └─ src/
│     ├─ modules/              # auth, wardrobe, garment, photo, damage, repair, wear,
│     │                        # fabric, reminder, analytics, export, share
│     ├─ services/             # 统计口径、提醒规则引擎、图片管线、复检、导出
│     └─ jobs/scheduler.ts     # node-cron：每小时扫提醒、每天刷健康分
└─ apps/web/                   # Vue 3 + Vite + Pinia + Element Plus + ECharts
   └─ src/
      ├─ components/           # PhotoAnnotator（Canvas 标记）、BeforeAfterSlider、PartPicker…
      ├─ views/                # 17 个页面
      └─ api/                  # 与后端模块一一对应的接口层
```

---

## 几个关键设计

### 1. 照片标记：坐标归一化，换设备不错位

标记坐标一律存 `x, y ∈ [0,1]`（4 位小数），渲染时才乘以显示尺寸。换算逻辑在 `packages/shared/src/geometry.ts`，前后端共用同一份实现，所以「画布上看到的点」和「后端校验/打印工单用到的点」永远一致。

服务端图片管线（`services/image.ts`）按顺序做：**EXIF 方向纠正 → 长边压到 2048 → 生成 512 缩略图 → 剥离 EXIF（含 GPS）→ sha256 落库**。第一步不做，手机竖拍图上的标记必然错位。

### 2. 提醒引擎：可执行、可收敛、幂等

- 每条提醒带 `actionKind`（如 `open_review_form`），点击直达预填好的表单，而不是只发一条消息；
- 提醒处理与业务记录**写在同一个事务**里，并回填 `resultRef`，无法"假完成"；
- 唯一约束 `(subjectType, subjectId, occurrenceKey)` 保证同一天同一件事不会重复轰炸；
- 每条提醒有 `expire_at`，超时自动转 `expired`，扫描后不存在僵尸待办。

内置 9 条规则：修补后复检、观察期提前提醒、高频穿着加检、洗护周期、换季检查、长期未处理破损、耗材低库存、服役评估、复发预警。

### 3. 统计口径先定义、后实现

`packages/shared/src/metrics.ts` 是唯一实现：复修率、修补寿命、每穿成本、年化成本、健康分、频率分档都在这里。**右删失**（修补后至今未复发）单独列示，绝不混进平均值——否则"刚补完还没坏"会被算成"超级耐用"。

### 4. 布料库存：补丁布也有档案

登记来源（原衣余料 / 同款旧衣拆解 / 市售补丁布…）→ 修补时选用并扣减库存（流水只增不改）→ 低于阈值触发补货提醒 → 补货后关闭提醒。顺带回答"这块布救过哪几件衣服、平均撑多久"。

---

## 测试

```bash
npm test
```

- `tests/metrics.test.ts`：统计口径（含右删失聚合、健康分四因子）
- `tests/geometry.test.ts`：坐标归一化、**围绕视口中心的缩放**、非正方形照片的命中容差
- `tests/reminders.test.ts`：提醒幂等、顺延后不过期、超时失效、退役清理
- `tests/backup.test.ts`：备份包内容、非 SQLite 备份被拒绝、只含图片的包不替换数据库
- `tests/robustness.test.ts`：**并发写入不冒 500**（建档编号 / 同日打点 / 修补轮次）、非法与未来日期、观察期未到的复检、备份数据隔离
- `tests/closed-loop.test.ts`：**真实 HTTP + 真实 SQLite + 真实图片处理**的完整闭环
  （建档 → 传图 → 标记 → 破损 → 修补 → 扣库存 → 变化 → 观察期 → 提醒幂等 → 打点 → 不合格返工 → 二轮修补复检通过 → 复发串链 → 退役 → 终身档案）

另外两套对着**正在运行的服务**跑的验收脚本（不需要测试框架，适合部署后自检）：

```bash
node apps/server/scripts/smoke.mjs http://localhost:3000     # 29 项写链路 + 闭环语义断言
npm run verify:api -- http://localhost:3000                  # 约 100 项全端点扫描（含负面鉴权用例）
```

Playwright 端到端覆盖 9 条真实浏览器链路：注册建档、上传照片 + 画布标记、列表缩略图、打点穿着、**破损→修补→复检闭环**、全部页面冒烟（含图表与字典页）、布料建档 + 只读分享链接、断网打点离线入队与自动同步、断网登记破损先落本机后同步、**多端版本冲突的提示与合并入口**。

---

## 离线工作流与多端合并

断网时高频记录不会丢，也不会在恢复网络后造出重复数据：

- **先落本地**：穿着打点、破损登记、修补登记在请求失败（`ERR_NETWORK`）时写入 `localStorage` 队列，顶栏显示「离线待同步 N」。每条记录带本地生成的 `clientOpId`。
- **整批幂等同步**：联网（`online` 事件 / 30 秒轮询 / 页面重开）后整批 POST 到 `/api/sync`，服务端逐条回报 `ok / duplicate / rejected / conflict`；同一操作重放（含两台设备同时同步）只建一条记录。
- **按记录版本合并**：`damage_events`、`repairs` 带单调递增的 `version`，每次修改 +1。客户端编辑时携带 `expectedVersion`，离线期间记录被其他端改过则返回 `VERSION_CONFLICT`（409），服务端保留先到的新版本、**不静默覆盖**；冲突的修补不会落库。
- **冲突结果必须被看到**：冲突/拒绝结果存入本地（`gml.syncIssues`），顶栏出现红色「同步冲突 N」标签，点开同步中心可看到"你基于 vN 编辑、服务端已是 vM"的说明，并一键跳到最新记录核对、手动把仍需要的内容补进去。
- **照片标记的离线边界**：标注与照片必须在线上传（要冻结为证据）。断网登记破损时若没有已上传标记，会引导用户勾选「位置不便标记」并用文字描述，避免收下同步时必然被拒的僵尸记录。

---

## 与项目文档的对应与偏差

实现严格按 [`../项目文档.md`](../项目文档.md) 落地，以下偏差已在文档第 21 章记录：

1. **`prisma db push` 在本机的兼容问题**：Prisma 的 schema engine 子进程在部分目录下会静默失败（只报 `Schema engine error`，无细节）。`npm run db:migrate` 因此改为「`migrate diff` 生成 SQL → 用 Prisma Client 执行建表」，行为确定、可复现，还留下了一份可读的表结构快照。
2. **提醒幂等键加强**：文档写的是 `(rule_id, subject_type, subject_id, occurrence_key)`，实现改为 `(subject_type, subject_id, occurrence_key)`，把事件驱动（`rule_id` 为空）的提醒也纳入去重。
3. **返工不伪造数据**：复检不合格选择「返工」时，系统生成一条**返工任务提醒**（带预填的破损事件），而不是凭空造一条修补记录——针法、用料、执行方必须由人来填。
4. **新增衣物字段** `last_washed_on`、`wears_since_wash`：为「洗护周期提醒」提供"上次清洗后穿了几次"的依据，并在衣物页提供「已清洗」一键归零。

---

## 常见问题

**Q：`npm run db:migrate` 报 `Schema engine error`？**
A：本机 Prisma schema engine 的兼容问题，本项目已绕开（脚本不再依赖 `db push`）。若你手动执行 Prisma 命令遇到同样报错，加上 `RUST_LOG=info` 通常即可。

**Q：照片上传后看不见？**
A：照片只通过鉴权接口返回，不挂静态目录。若 `<img>` 打不开，先确认登录态（token）有效。

**Q：HEIC 照片传不上去？**
A：浏览器端会先用 Canvas 压成 JPEG；Safari 之外的浏览器无法解码 HEIC，建议在相册里导出为 JPEG 再上传。

**Q：端口 3000 被占用？**
A：改 `.env` 的 `PORT`，并把前端代理指向新端口：`VITE_API_TARGET=http://localhost:3020 npm run dev:web`。

**Q：分享给别人的链接打不开？**
A：`WEB_ORIGIN` 留空时系统按请求来源自动推断（开发时是 5173，单端口部署时是同源地址）。如果你把它写死成别的地址，分享链接就会指向那个地址——请改成留空或填真实对外地址。

**Q：`npm ci --omit=dev` 装完能跑吗？**
A：可以。服务端运行时需要的 `tsx`（直接运行 TypeScript）与 `prisma` CLI（执行迁移）都在 `dependencies` 里。
