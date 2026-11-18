<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# 日历「改」功能分工

课程项目，8 人分四组，每组两人做 CRUD 里的一个。我们这组做**改**：编辑一条已有日程。

效果：组织者能改标题、时间、时区、地点、全天、状态；两人同时改只有一个成功，另一个提示"已被他人修改"；别人改了，你在 3 秒内收到提示。

日历是独立模块 Worker，有自己的 D1 库。

> 这份文档是课程协作材料，放在 `docs/calendar-edit-plan.md`，只留在开发分支，**不进 `main`**：fork 的 `main` 和上游 `main` 都不含它，上游 PR 里也不会出现。
>
> 合并到 `main` 时不要 merge 文档那个提交，而是从上游 `main` 重建，只 cherry-pick 代码提交：
>
> ```powershell
> git fetch upstream
> git checkout -B main upstream/main
> git cherry-pick <文档提交>..feat/calendarEdit    # 从文档提交之后开始，文档那个提交本身排除
> git push origin main
> ```
>
> 这样各开发分支上仍有这份文档，`main` 的树和历史里都没有。

## 先看一条：仓库对日历的既有定位

`docs/requirements.md` 的 4.2 写的是：日历通过 **CalDAV/JMAP/iCalendar 适配器**接入（Stalwart 为参考实现），前端要与标准 CalDAV 客户端互通；`docs/modules.md` 也把 "CalDAV（日历）" 列为适配器类模块的例子。

我们这套是自建 D1 存储 + 自研前端，属于**功能模块**路线，跟仓库规划有偏差。三种处理方式：

| 方案 | 做法 | 代价 |
|---|---|---|
| 甲 | 就按自建 CRUD 做，明说不合入上游、只作课程交付 | 零成本，但与需求文档不一致 |
| 乙 | 字段模型按 iCalendar 的 VEVENT 语义命名（UID、DTSTART、DTEND、TZID、RRULE、SEQUENCE） | 几乎零成本，将来加 CalDAV 适配层时不用重做数据模型 |
| 丙 | 真做 CalDAV 适配器 | 两人做"改"这个功能不现实，上游也没实现 |

建议走**乙**：表里多一个 `uid` 列，版本字段同时承担 `SEQUENCE` 的角色，其余不变。本文档按乙写。

## 仓库和分支

上游没给写权限，所以走 fork。两人都在同一个 fork 里干活。

```
UN-Self/unself  (upstream)
  └─ main ──────────────────────►  yyj138/unself  (origin，我们的工作仓库)
                                      main              上游基线，只同步不开发
                                       ├─ feat/calendarEdit   集成分支，最后 PR 的源分支
                                       │    ├─ editServer     A
                                       │    └─ editClient     B
```

规则：

- 只推 `origin`（自己的 fork），不推 `upstream`
- 两个子分支在 fork 里各开一个 PR 合到 `feat/calendarEdit`，互相 review（GitHub 不允许 approve 自己的 PR）
- `main` 只用来跟上游同步，任何时候不往上写代码
- 功能全部做完合进 `main` 后，从 `origin/main` 向上游 `main` 开**一次** PR

日常命令：

```powershell
git checkout editServer                 # 或 editClient
git push origin editServer
git fetch upstream
git rebase upstream/main                # 合并前对齐上游
```

## 开工顺序（第一天，别各干各的）

B-1 的测试工厂要加载 `migrations/calendar/0001_events.sql` 才能跑起来，而这份 SQL 是 A-1 的活。所以第一天的顺序是固定的：

1. **A 上午**：先把 A-1 里的两张建表 SQL 写出来交付（照本文档末尾的表结构写，半天的事）
2. **B 下午**：拿到 SQL 做 B-1 测试工厂，当天交付
3. **A 第二天起**：A-1 其余部分 → A-2 → A-3 → A-4 顺序推进
4. **B 第二天起**：B-2 → B-3 → B-4 顺序推进；**B-4 不等 A-4**，先用 B-2 准备的 mock changes 把轮询和提醒逻辑做完（见 B-2），A-4 交付后切真接口

不照这个顺序，第一天就是 B 等 SQL、A 不知道 B 在等。

## A 做的事（editServer）

**A-1 模块骨架和契约**
- `migrations/calendar/0001_events.sql`：两张表（见下），`CREATE TABLE/INDEX` 全部带 `IF NOT EXISTS`（**先做，B 的工厂等它**）
- `src/types.ts`：字段映射、类型、错误体
- `manifest.yaml`：字段必须按契约齐，缺一个装配就拒
- `package.json`（包名 `@unself/calendar`）、`wrangler.jsonc`、`tsconfig.json`、`scripts/build.mjs`
- `src/index.ts`：`GET /` 模块页、`GET /api/health`、两个业务路由占位、`/life/*` 生命周期端点

`manifest.yaml` 照这个写（字段定义见 `docs/modules.md` §3）：

```yaml
id: calendar
route: /m/calendar
runtimes:
  - worker
version: 0.1.0
description: 团队日历
permissions:
  - storage
storage:
  accepts:
    - core
  preferred: core
tables:
  - calendar_events
  - calendar_event_changes
```

`permissions` 照 chat 声明 `storage`：仓库里 hello 和 chat 两个现成模块都带这一行，chat 与我们同路线（专属 D1 + 关系表、不走 storage 键值代理）。permissions 是装配门禁字段，缺了有被拒装的风险，宁多勿少。表名必须以模块 id 开头（`calendar_`），这是迁移契约的硬要求。

`/life/export` 和 `/life/purge` 是模块生命周期契约，必须实现，照 hello 的写法抄。这两个端点的鉴权方式跟业务接口一致。

`index.ts` 在这里一次写好挂载，之后谁都不再改它，否则必冲突。

**A-2 校验和数据库操作**
- `src/events/validate.ts`：标题 1-200、开始早于结束、时区合法、状态枚举、只读字段拒绝、未知字段拒绝
- `src/events/store.ts`：查一条、带版本号的条件更新（`WHERE version = ?`）、写一条变更记录

要点：D1 **没有** `BEGIN`/`COMMIT`，不要按事务写。以条件 UPDATE 为准（`meta.changes` 为 0 就判冲突），变更记录用独立 INSERT；即使 INSERT 失败，数据仍是正确的，只少一条提示记录，下次修改会补上。不要为了"原子"去设计两段提交。

**A-3 编辑接口**
- `src/routes/events.ts`：`PATCH /api/events/:id`
- 流程：验 token（`aud` 必须是 calendar）→ 查记录 → 判组织者 → 校验 → 条件更新 → 返回
- 顺手交付 `seed.sql`（往 `calendar_events` 手动 INSERT 一条测试日程）给联调用，别等增组

交什么：路由级集成测试覆盖 200、400、401、403、404（已删除）、409，外加并发只成功一个。测试用 `app.fetch` 打真路由，不直接测内部函数。

**A-4 变更流接口**
- `src/routes/changes.ts`：`GET /api/events/changes?since=&excludeEventId=`

交什么：覆盖空游标、增量、同一毫秒多条、排除自己刚改的那条。

## B 做的事（editClient）

**B-1 测试工厂**
- `test/calendar-test-factory.ts`：**复用** `app/workbench/test/test-factory.ts` 的 D1 适配器（`node:sqlite`），只把迁移目录换成 `migrations/calendar/`
- 不要从 chat 模块抄一份，也不要手搓假 D1：按 `docs/testing.md`，没有 schema 的假 D1 会让写错的 SQL 也变绿

交什么：A 能拿它跑 A-2、A-3、A-4 的测试。**前置：A 第一天上午交付的 0001 SQL。**

**B-2 前端工程和接口调用**
- `frontend/` 骨架，`vite.config.ts` 输出到 `../assets`
- `frontend/src/lib/api.ts`：PATCH 和 changes 的客户端；409 抛出携带服务端当前值的错误；401 提示登录过期
- `frontend/assets/mock/event.json`：查组交付前先用它
- `frontend/assets/mock/changes.json`：**假变更流**。B-4 的轮询、游标推进、去重、提醒横幅先用它跑通，不等 A-4；A-4 交付后把请求地址从 mock 切到真接口即可
- 照 chat 的 `frontend/public/dev-shim.html` 抄一个假壳页：页面在假壳里就能拿假 token、直接请求 8788 联调，**不需要等工作台**

两层路径分清楚：浏览器侧 SDK 是**平台注入**的（装配器把 `assets/sdk/module-sdk.esm.js` 搬进部署目录），模块包里**不要**自带 SDK；页面里写 `import ... from './sdk/module-sdk.esm.js'` 即可。

**B-3 编辑界面**
- `frontend/src/lib/validate.ts`：规则跟后端一致，常量从 `src/types.ts` 读
- `EventEditor.vue`：六个字段的表单、保存中禁用、保存成功提示
- `RemoteEditBanner.vue`：「此日程已被 XXX 修改（标题、时间）」加刷新 / 保留两个按钮

仓库 UI 约束：样式只用 `--unself-*` tokens 不自造颜色；图标用 Lucide；动效参数从 tokens 取并对 reduced-motion 降级；权限判断只信服务端，前端不下权限结论。

**B-4 实时和页面装配**
- `use-event-changes.ts`：每 3 秒拉 changes，游标推进，命中正在编辑的那条就提示；先接 `mock/changes.json` 跑通全套逻辑（含后台暂停、切回补拉），A-4 好了切真接口
- `App.vue`：SDK 握手、加载日程、挂编辑器和轮询
- 页面切后台暂停，切回立刻补一次

交什么：两个浏览器互改同一条，3 秒内看到提示。

## 两人之间要对接的

| 谁给谁 | 东西 | 时间点 |
|---|---|---|
| A → B | `0001_events.sql`（B-1 的前置） | **第一天上午** |
| A → B | `src/types.ts` 字段名、错误码、changes 结构 | A-1 做完 |
| B → A | 测试工厂 | A 开始 A-2 之前 |
| A → B | 本地可跑的后端（8788） | A-3 做完 |
| A → B | changes 接口可用 | A-4 做完（B-4 不等它，先跑 mock） |
| B → A | 409 要展示哪些字段 | B-3 前 |
| A → B | `seed.sql` 测试日程 | A-3 做完 |

四条硬约定：

1. 字段名一律 API 名（`startAt`，不是 `start_at`）
2. 每次修改 `version` 加 1，请求必须带 version
3. 409 必须带当前 event，前端直接显示
4. 同一毫秒可能返回多条变更，前端按 eventId 去重取最大版本

## 要提前跟另外三组说好的

**查组**
- 详情接口用同一套字段和同一个映射函数
- 我们的 `EventEditor.vue` 以组件形式给他们用
- 他们若有编辑入口，必须调我们的 PATCH
- 他们没交付前，A 先加只读 `GET /api/events/:id` 自测，联调时删掉

**增组**
- 新建时 `version` 写 1
- id 用 nanoid 21 位；表里另存 `uid` 作为 iCalendar 的 UID
- 时间存 UTC 毫秒 + IANA 时区名，不存本地时间字符串
- 他们写的 RRULE 我们能原样回写，所以格式要能原样取回
- 参会人表名要跟我们 `tables` 申报一致，且以 `calendar_` 开头
- **我们联调不依赖他们的 POST**：测试日程用 A-3 的 `seed.sql` 自己造

**删组**
- 用 `deleted_at` 软删，非空我们一律 404
- 删除也要写一条变更记录（`changed_fields` 含 `deleted`），否则正在编辑的人收不到"已被删除"
- `status: cancelled` 是"取消但保留"，跟他们删除不是一回事

## 怎么联调

1. **先打通页面（不用等工作台）**：B 用 dev-shim 假壳打开页面，请求指向 A 的 8788，先把接口和页面调通
2. **再挂真壳**：把 calendar 注册进本地 workbench（8787），从侧栏图标进真 iframe，验证 SDK 握手和 token
3. **测试日程自己造**：A 用 `seed.sql` 往 `calendar_events` 手动 INSERT 一条，别等增组
4. 两个浏览器登录同一团队，打开同一条日程
5. 跑用例：

| 编号 | 做什么 | 预期 |
|---|---|---|
| T1 | 改标题保存 | 页面立刻显示新值 |
| T2 | 结束早于开始 | 拦下并指出字段 |
| T3 | 两端同时提交同一版本 | 一个成功，另一个提示冲突并显示最新值 |
| T4 | 一端改，另一端停在编辑器 | 3 秒内提示"已被修改" |
| T5 | token 过期再保存 | 提示登录过期，不出现错误码 |
| T6 | 375px 宽度 | 能看能改，按钮不重叠 |

4. 全过后跑门禁（跟 CI 同一套）：

```
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r typecheck
pnpm -r test
```

5. 页面要用浏览器真打开一次并截图，截图贴 PR；`/api/health` 返回 200 不算页面能用。

> 上面的编号接续前一步的"5. 跑用例"，两段合起来读。

## 提交和合并

- 提交信息以任务号开头：`A-1：建模块骨架和契约`、`B-2：前端骨架和接口调用`
- **每个提交必须带 sign-off**：`git commit -s`（仓库用 DCO，不带会被打回）
- 新代码文件头加 `// SPDX-License-Identifier: AGPL-3.0-only`
- 一个任务做完提交一次，不按小改动频繁提
- 不属于任务的零改动写 `feat：` 或 `docs：`
- 推 `origin`，不推 `upstream`
- 合回 `feat/calendarEdit` 前先 `git rebase origin/feat/calendarEdit`
- 按 CONTRIBUTING，开 PR 前先在上游开 issue 说明要做什么
- 这份分工文档只存在于开发分支，合进 `main` 时剔除（命令见文档开头），`main` 和上游 PR 都不含它

## 表结构（A-1 要建的）

```
calendar_events
  id, uid, title, description, location,
  start_at, end_at, all_day, timezone,
  organizer_id, response_state, rrule, status,
  version, created_at, updated_at, deleted_at

calendar_event_changes
  id, event_id, actor_id, actor_name,
  from_version, to_version, changed_fields, created_at
```

时间字段存 UTC 毫秒；`changed_fields` 存 JSON 数组，元素用 API 字段名。表名以 `calendar_` 开头、迁移文件叫 `000N_描述.sql`、已执行过的迁移不能再改（改了也不会重跑）。

## 接口

```
PATCH /api/events/:id
{ "title": "...", "startAt": 1763500800000, "endAt": 1763504400000,
  "timezone": "Asia/Shanghai", "version": 3 }

200 → { event, version }
400 → { error, field }
401 → { error }
403 → { error }
404 → { error }
409 → { error: "version_conflict", event, version }

GET /api/events/changes?since=<毫秒>&excludeEventId=<id>
200 → { changes: [{ eventId, actorName, toVersion, changedFields, createdAt }], cursor }

GET /api/health → { ok: true }
GET /life/export → 导出数据
POST /life/purge → 清空数据
```

## 仓库规范对照（对齐后改了什么）

| 仓库要求 | 出处 | 原来写的 | 现在改成 |
|---|---|---|---|
| manifest 是 `manifest.yaml`，构建生成 `manifest.json` | modules.md §2 | 只提 yaml | 明确 build.mjs 要生成 json |
| 字段含 `runtimes`、`version`，`route` 以 `/m/` 开头，`storage` 是对象 | modules.md §3 | `storage: core` 字符串 | 改成 `storage: { accepts, preferred }` 对象 |
| 表名必须以模块 id 开头 | modules.md §6 | 未强调 | 明确 `calendar_` 前缀 |
| 迁移只增不改，失败整份重放 | modules.md §6 | 只说 IF NOT EXISTS | 补"已执行的迁移不能改" |
| 必须有 `/life/export`、`/life/purge`、`/api/health` | modules.md §9 | 漏了 | 补进 A-1 |
| 浏览器 SDK 由平台注入 | modules.md §9 | 未区分 | 只引用 `./sdk/...`，不自带 |
| D1 没有事务 | AGENTS.md | 原打算靠 batch 原子 | 改成不依赖事务 |
| 测试用真 SQLite 加载真迁移 | testing.md | 说从 chat 抄 | 改成复用 workbench 的 test-factory |
| 提交要 DCO sign-off | CONTRIBUTING | 未提 | 补 `git commit -s` |
| 分支用 `feat/xxx` | CONTRIBUTING | `calendarEdit` | 改 `feat/calendarEdit` |
| 数据模型变更先改需求文档 | CONTRIBUTING | 未提 | 见下方"还有两件事没定" |

## 两件的定案（2026-11-18）

1. **需求偏差**：按课程交付处理，**不改上游文档**。PR 说明里写清"与 requirements 4.2 的 CalDAV 路线不同，自建 D1 + 自研前端"。字段模型已按方案乙对齐 iCalendar 语义（UID / SEQUENCE），将来要补 CalDAV 适配层时数据模型不用重做——后路已留，不再额外投入。想让上游收编再议（按 CONTRIBUTING 得先改 `docs/PRODUCT_SPEC.md` 和 `docs/requirements.md`，那是另一份工作量）。
2. **测试口径**：A-3 / A-4 清单里的集成测试是任务交付物，照写。之后让 AI 写代码时，想要测试必须明确说"要写测试"，否则 AI 按 AGENTS.md 的规则只交功能代码。

## 本次修订对照（2026-11-18）

| 问题 | 原来写的 | 现在改成 |
|---|---|---|
| 第一天开工顺序 | 只写"工厂 A-2 前要给" | 新增「开工顺序」节：A 第一天上午先交 SQL，B 下午做工厂 |
| B-4 无保底 | mock 只备了 `event.json` | B-2 加 `changes.json` 假变更流，B-4 先跑 mock 不等 A-4 |
| manifest 少 permissions | "不要声明，声明了反而没用" | 照 chat 声明 `permissions: [storage]`（两个现成模块都带，是门禁字段） |
| 联调没有日程可改 | 未提 | A-3 交付 `seed.sql`，测试日程自己 INSERT，不等增组 |
| 前端联调跑在哪 | 只说"A 起后端 B 指地址" | 两层：先 chat 式 dev-shim 假壳打通接口，再注册进 workbench 真壳 |

## 仓库权限和提交方式

上游没给写权限，所以走 fork：

1. 代码推到 `yyj138/unself`（`origin`）
2. 做完后从 fork 的 `main` 向上游 `main` 开 PR，PR 编号、评论、review、CI 检查记录都会留在 `UN-Self/unself`
3. 首次贡献者的 fork PR，需要 owner 点一次 "Approve and run"，CI 才会跑
4. PR 打开后不要再往 fork 的 `main` 推提交，head 是分支引用，会把新提交算进 PR
5. 提交必须 `git commit -s`，签名邮箱要先绑定到 GitHub 账号（本机是 `1952045685@qq.com`）

## 两个已知的坑

1. 新建模块的 `scripts/build.mjs` 不要照 hello 写 `new URL('..', import.meta.url).pathname`，Windows 上会变成 `/E:/...`，esbuild 报 not an absolute path；用 `fileURLToPath`。
2. 前端 `package.json` 的 build 不要写 `FOO=bar vite build`，Windows 的 cmd 不认。
