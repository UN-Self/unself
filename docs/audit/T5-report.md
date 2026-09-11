# T5 报告：M0 测试零覆盖面盘点（子任务③）

- 审核对象：`origin/m0/dev` @ `57a2d73f5662f3f2a43876a852b7e15486048077`
- 方法：`git archive origin/m0/dev` 抽取到 `/tmp/audit/wt-3`（对仓库零写入，未读工作区源码）；gh 仅只读命令
- 测试总量（25 个 test 文件，~191 个 it）：deploy 25（assemble 7 / config 7 / provision-registry 7 / steps 4）、core-api 60（oidc 15 / auth-routes 12 / setup 7 / keys 7 / registry 6 / session 6 / token 6 / core-api 1）、shell 39、module-sdk 32、contracts 23、hello 10、ui 2
- 总判断：**单测面广但全部是「单元级 + 内存假 D1/fetch 注入口」；九个关键面无一有「真 schema/真生成物/真链路」级测试**。已发生 6 次真机事故（#15 CLI 契约、#51/52 wrapper.fetch、#53 /setup 404、#54 custom_domains 形态、#56 幻影列、#58 wrapper 资产分支），全部属于「单测绿了照样炸」类，且当前测试对其中 3 类（#53/#54/#56）仍无回归防线。

---

## A 节：九个面逐面盘点

### A1. 迁移 ↔ 查询一致性 —— 零覆盖（最危险的裸奔面）

**覆盖现状**
- 全仓无任何测试读取 `services/core-api/migrations/core/*.sql` 或 `modules/hello/migrations/hello/*.sql`（grep 全仓，仅 `steps.ts:30,106` / `assemble.test.ts:83,89` 以字符串常量引用目录路径；无 readFile/执行）。
- 所有 core-api 测试用「SQL 子串匹配」内存假 D1：
  - `registry.test.ts:18-48`：`first()` 用 `sql.includes('UPDATE module_registry')`、`all()` 用 `sql.includes('FROM module_registry')` 命中后直接返回行对象——**SELECT 的列清单完全不参与判断**，`SELECT registered_at FROM ...`（幻影列）照样通过；
  - `token.test.ts:9-45`、`setup.test.ts:14-52`、`auth-routes.test.ts:74-86`（全接受 stub）、`hello.test.ts:21-57`（module_kv 语义 stub）同构。
- 迁移 0001/0002/0003 建表（users/module_registry/acl/audit_log/instance_config/setup_tokens/oidc_flows）无任何测试驱动建 schema；也没有「SQL 列集合 ⊆ 迁移 DDL 列集合」的静态或运行时校验。

**缺口**：查询 SQL 与迁移 DDL 的「两张皮」没有任何机制会暴露。

**真机对应事故**
- PR #56 / d675757（issue #55 补记）：`listModules` SELECT 了从未存在的 `registered_at` → 线上 `GET /api/modules`、`GET /api/admin/modules` 全 500。原话：「单测的内存假 D1 只认 SQL 子串、行结构自带该列，**两张皮掩盖了真实列集合（56 用例全绿照样炸）**」。
- 现状代码已在 `registry.ts:75-78` 留注释并在 `SELECT` 中去掉幻影列，**但没有测试能防止同类回归**（假 D1 行结构本身由测试自造，测试与查询同步改，永远一致）。

**建议补法（最低成本）**
1. 新建 `services/core-api/test/schema-alignment.test.ts`：用 Node 22 内置 `node:sqlite`（零新依赖）读 `migrations/core/*.sql` 按序执行建 schema，写一个 ~60 行的 D1 最小适配器（prepare/bind/first/all/run 四方法），把 `upsertModule/listModules/toggleModule/checkTokenGate/setup 各函数` 跑在真 SQLite 上断言结果形状（尤其：查询缺列/多列在真 D1 上会抛错，测试即红）。hello 模块迁移同构一套。
2. 如果不想引 SQLite：退而求其次，写「DDL 列集合 vs 源码 SQL 列集合」的正则静态对齐测试（成本更低但只防列名，不防其他 DDL 语义）。

---

### A2. 生成 wrangler 配置的语义 —— 字段级断言，非语义级；且与真机契约漂移面零防线

**覆盖现状**（`deploy/cloudflare/test/assemble.test.ts`，7 个 it）
- `coreWranglerConfig`（it:19-29）：断言两 D1 真实 id、`not_found_handling: 'single-page-application'`、`run_worker_first` **contains** `'/api/*'`、`routes=[{pattern:'team.example.com', custom_domain:true}]`、domain 空无 routes、字节确定性。
- `moduleWranglerConfig`（it:55-67）：断言 `routes=[{pattern:'hello.team.example.com',custom_domain:true}]`、D1 id、`vars.CORE_JWKS_URL`、`vars.MODULE_ID`。
- `migrationWranglerConfig`（it:78-93）：字段原样内嵌。`config.ts` 7 个 it 覆盖 jsonc 解析。

**漏掉的语义**（对照 `assemble.ts` 生成逻辑）
- core：`assets.directory/binding`（未断言）、`run_worker_first` 全量（只断言 `/api/*`；`'/setup*'`、`'/.well-known/*'` 无断言——**#53 的修复点零回归防线**）、`vars.UNSELF_BASE_URL`（`assemble.ts:215` 生成但无断言）、workers.dev 回退时 vars 缺省。
- module：整个 `assets` 块（`directory/not_found_handling:'none'/run_worker_first:true`，`assemble.ts:247-252`）零断言；`jwksUrl != null` 覆盖分支（`assemble.ts:262`，steps 步骤④显式传值的路径）零断言。
- 测试措辞漂移：it:55 标题写「route 绑定 /m/<id>/*」，实际断言的是子域形态 `hello.team.example.com`（§5.3/决策 #13 要求的是**主域路径** `/m/<id>/*`）——测试标题与断言不一致，反映了拓扑本身的偏差（见 A4）。

**真机对应事故史**（全部为「单测绿、真机炸」）
- #15 → PR #50（91bd02c）：wrangler 4.129 实际 CLI 契约 vs #14 按 v3 形状录制的 fake，13 项漂移。原话：「单测 24 个全绿证不了 CLI 契约」。
- PR #51（e8b1660）：OAuth 对 zone 路由报 10405 → 改顶层 `custom_domains`；PR #54 / 66e8f21：wrangler v4 无顶层 `custom_domains` 字段（真机 Unexpected fields，仅警告不生效）→ 才改为 `routes + custom_domain:true`。当前测试断言的正是「事后正确形态」，但**两头错误形态都未被任何测试约束过**。
- PR #53 / df9693e：`run_worker_first: ['/setup']` 精确路径语义不匹配 `/setup?token=…` → 改 `/setup*`。**当前测试仍只断言 `/api/*`**，本可防的回归没有防线。

**建议补法（最低成本）**
1. 把 assemble.test.ts 的逐字段断言升级为**整对象 toEqual 快照断言**（core/module 各一例，含 workers.dev 变体）；对 `config-schema.json`（仓库内 `node_modules/wrangler/config-schema.json`）用 ajv 校验生成物——#54 的「Unexpected fields」类问题即可在 CI 暴露。
2. 集成级（中成本，建议后续）：`wrangler deploy --dry-run --config <生成物>` 冒烟，锁住 CLI 契约（回应 #50 的自供）。
3. 明确把 `'/setup*'`、`UNSELF_BASE_URL`、module `assets` 块写进断言（半小时内）。

---

### A3. wrapper 生成物（prefixStripWrapperSource） —— 仅三行字符串级断言，无行为测试

**覆盖现状**（`assemble.test.ts:69-77`）：`toContain` 三连——`const PREFIX = '/m/hello'`、`url.pathname = url.pathname.slice(PREFIX.length)`、`import worker from './app.js'`。**不执行任何请求、不 mock ASSETS、不覆盖任何分支**。

**缺口**（`assemble.ts:295-330` 生成体的全部行为）：
- `isAsset` 判定矩阵：`/m/<id>/api/*`、`/m/<id>/life/*`、POST/其它方法、`/m/<id>/` 本体、`/m/<id>` 无斜杠、`/m/<id>/x/../sdk/y`、带 query 的资产请求——全无测试；
- 资产分支的 `PREFIX.length + 1` 边界（`assemble.ts:309`，恰好是 #58 的第二个坑点）；
- 资产回退后的 `ASSETS.fetch('/' + assetPath)` 与「空路径落 Hono 根渲染」的分流；
- GET `/m/<id>/`（或 `/`）时先试 `ASSETS.fetch('/index.html')` 404 则落 worker 的路径（`assemble.ts:317-319`）。
- 模板头注释自称「绝对 URL 头重写」，实现里并无任何头重写代码——注释与实现漂移（次要发现）。

**真机对应事故**（两次，均属「字符串测试全绿、行为必炸」类）
- PR #52 / e5df996：wrapper 直调 `index_default`（模块 bundle 默认导出对象）→ workerd 报 `index_default is not a function`，模块 API 全 500 → 改 `worker.fetch`。
- PR #58 / 57a2d73（当前 HEAD）：① 资产路径错位——页面相对引用 `./sdk/module-sdk.js` → 请求 `/m/hello/sdk/...`，旧 wrapper 找 `ASSETS.fetch('/assets/sdk/...')`（部署目录布局被当 URL 空间）必 404；② `/m/hello/` 本体误入资产分支找 index.html → 404 空体（页面由 Hono 渲染，无静态 index.html）。

**建议补法（最低成本）**
1. 把 `isAsset` 判定与「剥前缀→资产路径/**落 worker**」分流抽成**纯函数**（`decideWrapperRoute(pathname, method)` → `{kind:'asset', path}|{kind:'worker'}`），对判定矩阵做表驱动单测（约 15 行测试覆盖上面全部边界）。抽出后 wrapper 模板只负责胶水。
2. 次选（也便宜）：测试里把 wrapper 源码写到临时目录 + 生成一个 stub `app.js`，`import()` 生成物后用 mock env（ASSETS.fetch 返回 200/404）直接发 Request 断言响应——不依赖 workerd，能执行真实生成代码。
3. 把 #52 的「对象非函数」类问题化为静态断言：生成 template 里 `worker.fetch(...)` 字样 + 一项「bundle 默认导出对象」的契约注释（成本低，防回退）。

---

### A4. iframe 装载拓扑 —— 三处一致性零集成测试；且现有断言编码了 bug（#57 仍 OPEN）

**覆盖现状**
- 单点纯函数测试齐备：`moduleFrameSrc`（`registry-api.test.ts`：同域→相对路径/独立域名→绝对/缺 entry→null/纯路径容错）、`frameOriginFor`（`module-bridge.test.ts`：4 用例）。
- SDK 侧握手行为已测：`sdk.test.ts:108-190`（waitForToken 非法 origin 不 resolve、形状校验、未配置 coreOrigin 拒绝）+ `sdk.test.ts:202-265`（startTokenLoop 静默续期前置量/重发 ready/非法 origin 忽略）。
- **壳侧 `attachModuleBridge` 零测试**：`module-bridge.ts:18-58` 的「message 监听 → origin 校验 → event.source 校验 → SdkMessageSchema 解析 → POST /api/modules/:id/token → postMessage(token, frameOrigin)」全流程无任何测试调用它（全仓 grep，仅 App.vue 消费）。
- **`token-api.ts`（fetchModuleToken）零测试**（无 token-api.test.ts 文件；App.vue:184-186 注释「此处仅暴露状态给测试/人工验收」——实际没有测试接住）。
- **App.vue / router.ts / SetupView.vue / LoginView.vue 零组件测试**：shell 的 devDeps 无 @vue/test-utils、无 jsdom/happy-dom（`apps/shell/package.json`），Vue 组件与路由守卫完全无覆盖。
- 关键三方一致性，测试现状是**各测各的、且互相矛盾**：
  - `registry.ts:45` 生成 `entry: https://<主域>/m/<id>/`（baseUrl 主域）；
  - `assemble.ts:244` 生成模块路由 `pattern: <id>.<主域>`（**子域** custom domain）；
  - `steps.ts:240-245` 冒烟目标 → `moduleSubdomain: true` 时打 `https://<id>.<host>/m/<id>/api/health`；
  - `registry-api.ts:60-66` moduleFrameSrc 把同域 entry 转为**主域**相对路径 `/m/<id>/` 装 iframe。
  - `provision-registry.test.ts:59-62` 断言 `entry === 'https://team.example.com/m/hello/'`（**主域**），`assemble.test.ts:55-58` 断言路由在**子域** `hello.team.example.com`——**两条测试各自绿，合起来就是 #57 的 bug**：iframe 装主域 `/m/hello/`，被壳 SPA 200 兜底成壳 HTML。

**真机对应事故**
- issue #57（OPEN @ HEAD）：「manifest.entry 还是指向主域路径，iframe 在主域拿到的是壳 SPA HTML」。经用户拍板（2026-09-08）选 B 方案：回归 §5.3 单域名路径制（zone 路由 + 部署凭证补 zone 级 API Token），实施待新会话；且拍板明确包含「**smoke/测试同步**」。
- 附带：`coreWorkerEntrySource` 的 SPA 回退（`steps.ts:327-356`，A9 详述）与 core 资产 `not_found_handling: 'single-page-application'`（`assemble.ts:198`）任一都可使主域 `/m/<id>/` 得到壳 HTML——两条路径均无测试。

**建议补法（最低成本）**
1. **一致性红测**：一个测试同吃「unself.config.jsonc（domain + modules）→ buildManifestSnapshot(entry) + moduleWranglerConfig(route) + moduleFrameSrc(entry)」，断言「iframe 实际装载 URL 的 origin+path」与「模块 worker 路由」指向同一挂载点。**HEAD 上此测试为红**（entry 主域 vs route 子域）——它精确把 #57 钉进 CI。待 #57 修复（entry 回归主域 `https://<主域>/m/<id>/`、wrangler 改 zone 路径路由）后转绿，并约束 smoke 目标同步回主域路径制（当前冒烟走子域，与 B 方案也需同步）。
2. `attachModuleBridge` 补 jsdom-free 测试：stub `globalThis.window.addEventListener` + 假 iframe（`contentWindow`/`postMessage` spy），模拟 ready 消息（origin 合/不合、source 不是该 iframe、形状坏），断言 token 端点被调、消息以 `{type:'token'}` 且 targetOrigin=frameOrigin 发出；再补 token 端点 403/超时 → onError。约 60 行。
3. `fetchModuleToken` 直接补 5 个分支（200/401/403/404/网络断），mock fetch 即可。

---

### A5. OIDC 全流程 —— 发现/授权/callback 单元级覆盖充分；「发现失败 → 登录链路」与「callback 失败态」路由级缺口

**覆盖现状**
- `oidc.test.ts`（15 it）：buildAuthorizationRequest 参数/PKCE S256 真值校验/每次独立；discover 正常 + issuer 不匹配；exchangeAuthorizationCode 用**真 RS256 密钥**验签闭环 + 坏签名/缺 jwks_uri fail-closed/JWKS 500/state 不匹配/provider error/nonce/iss/exp/aud 不匹配——单元级已全面。
- `auth-routes.test.ts`（12 it）：login 302 + 流程 Cookie 属性（HttpOnly/SameSite=Lax/Secure）；**callback 完整链路**（假 IdP 全局 fetch 拦截 + 真 RS256 id_token → JIT 建档 → 会话 Cookie → /api/me → logout）；callback 无流程 Cookie 400；未配置 login 503；test-connection 五例（200/缺 jwks 502/http issuer 400/非法 URL/缺 body）。
- `setup.test.ts` 覆盖「表优先」配置读取（activate 落库后、env 无 OIDC_* 时 login 302 → 假发现文档）。

**被 mock 掉/未覆盖的环节**
- IdP 全假（全局 fetch）：真 IdP 的 discovery/DNS/证书/失败形态不进任何自动化测试（真机兜底：Stalwart/Keycloak 手工验收，issue #5 验收原文）。
- **路由级失败态缺口**：`index.ts:160-186` callback 路由对 `exchangeAuthorizationCode` 抛错（坏签名/过期等）**无 try/catch**——错误将 500；§6.5/#11 验收要求「OIDC 配置损坏时成员看到人话，非堆栈」「state/PKCE 校验失败显示'登录暂时不可用'」。oidc.test.ts 的失败用例全在**函数级**，没有任何 `app.request('/api/auth/callback?...')` 断言浏览器看到的状态码/body。
- login 路由里 `discover()` 失败同样无兜底（`index.ts:139-140`）：假 IdP 只被 test-connection 的 502 用例覆盖，真登录路径的 discovery 失败 → 500 未测。
- `getOidcConfig` 的「表不存在 catch 落 env」分支（`index.ts:101-108`）只被间接覆盖。
- 无任何「两套配置（表 vs env）优先级」的互斥例（表有值 + env 有值 → 表优先无测试）。

**真机对应**
- #44（PR #46）：真机曝光 activate 持久化缺口（原实现只写 setup_done，向导 OIDC 字段落空）——此缺口当时也没有测试（修复后才补「写库 4 键 + 表优先 302」用例）。
- #55（OPEN）：首次激活死循环（见 A6），链路级测试不存在。

**建议补法（最低成本）**
1. 在 `auth-routes.test.ts` 补 2-3 个路由级用例：已签发但**坏签名** id_token 的 callback；JWKS 500 的 callback；login 时 discovery 502——断言非 5xx 原始堆栈、body 为人话（当前实现会 500，此测试先红后修——这正是「单测证不了的契约」）。
2. 表+/env 双配置优先级一例（改动最小）。
3. 记录：「全流程含真 IdP」无自动化，由 issue #5/#16 真机验收覆盖——建议在 README/验收记录中固定为文档化手工步骤而非 CI 负担。

---

### A6. setup token 消费时序 —— 主链路覆盖好；并发/TOCTOU、已激活重定向端到端、#55 死锁路径零覆盖

**覆盖现状**（`setup.test.ts`，7 it）
- 生成 token 200 + 409（已封死）；status 三态（done/tokenValid 无/有）；激活全链（未登录 401 + loginUrl → 登录激活 → 升 admin → **同 token 重放 409** → 激活后再发 token 409 → 审计 setup_token_issued/setup_activated）；伪造 token 403 且不提权；缺 token 400；OIDC 字段持久化 + 表优先登录 302；非法字段忽略。决策 #21 的「已激活后 /setup 重定向」在 `setup-guard.test.ts`（4 it，纯函数）有覆盖。
- 单测闭环较全，**但全部跑在内存 Map 假 D1 上**（`setup.test.ts:14-52`），SQL 时序、原子性均为测试自造语义。

**缺口**
- **无并发/竞态用例**：`setup.ts:55-68 consumeSetupToken` 是「SELECT used_at → 未用则 UPDATE」两步（TOCTOU）：两个并发 activate 同 token 可双双通过检查（SELECT 都看到未用、第二次 UPDATE 影响 0 行也无感知，返回仍 true）——真 D1 下会**双提升、双 markSetupDone**。测试无 Promise.all 并发例；且假 D1 无法暴露。
- 无「consume 后 status 的 tokenValid 翻转」用例（间接有：重放 → 封死优先）。
- 决策 #21 重定向只测了纯函数，router.beforeEach（`router.ts:18-37`）与 SetupView 无测试（无组件测试基建，见 A4）。
- **#55（OPEN）死锁路径零覆盖**：生产「env 无 OIDC_*、配置只在 activate 落库、而 activate 又要求已登录会话」——现有 activate 用例都是**预签会话 Cookie**（`setup.test.ts:41-46 envFor` 直接 createSessionToken），绕过了「登录 → 配置必须先存在」的依赖环。任何测试都没走「新实例：无配置 → 无 session → activate 无法进行」路径。
- 已激活后「/setup 一律重定向」的真机行为无端到端（浏览器）测试。

**真机对应**
- #55（OPEN @ HEAD）：「首次激活死循环——OIDC 凭据落库时机在登录之后，登录又依赖该配置」（真机：用户登录走通是**靠 env secrets 兜底**才激活的，实例已 done:true；生产迁移掉 env 后死锁修复仍待做）。

**建议补法（最低成本）**
1. `consumeSetupToken` 改为单语句原子消费：`UPDATE setup_tokens SET used_at=datetime('now') WHERE token=? AND used_at IS NULL` 后检查 `meta.changes === 1`（D1 run 返回 changes）——改动 5 行；配合 A1 的真 SQLite 适配器写并发用例（两个 Promise.all 同时 consume 同 token，断言恰一个 true）。若不动代码则至少补一条「假 D1 上并发」用例标注其无法证伪竞态的局限。
2. #55 修复后补「新实例无 env 配置全链」回归测试：`GET /api/auth/login` 503 → 激活（含先落配置再登录的修复后时序）→ login 302 走表配置。
3. setup-guard 的红/黄路径已够；router 端到端待引入组件测试后补。

---

### A7. 启停门禁传播链 —— 各环节单测齐，但无「一条 DB 实例串起来」的链路级测试

**覆盖现状**（分片但各环节都有）
- PATCH 翻转 + 404 + 审计：`registry.test.ts:65-83,100-113`；
- 成员侧 only-enabled 过滤：`registry.test.ts:85-99`；
- token 门禁 401/404/403 + JWKS 可验签 + 重新启用后可再取：`token.test.ts:76-165`；
- 侧栏隐藏（数据层）：`nav.test.ts:11-17`（buildNav 过滤 disabled）。

**缺口**
- 无「toggle(disable) → 同一 DB → token 端点 403 → toggle(enable) → token 200 → GET /api/modules 重新出现」的**单测试链**：`token.test.ts` 的 403 用预造行（`makeDb({registry:[...enabled:0]})`），`registry.test.ts` 的翻转用自己一套 makeDb——两套 stub 互不连通，翻转语义与门禁语义之间的「秒级生效」没有一把链测试。
- App.vue 侧（switch 后侧栏消失/恢复 + iframe 卸载）无组件级测试；真机验收在 #12 验收 1（「关 hello 边栏即消失、直访 /m/hello/ 领不到新 token；重开恢复」）——属七步剧本手工步骤。
- 模块侧「停用后已有 token 的清理/踢人」为远期项（§5.2），M0 无测试（非缺口，注明）。

**真机对应**：链上每环节在 #15/#16 真机走通过；无该链的专项真机事故——但同链在 issue #45（hello 鉴权统一 + /life/* 收紧，OPEN）中即将变动，届时无链测试兜底。

**建议补法（最低成本）**
1. `tests` 里加一条链用例（借助 A1 的真 SQLite 适配器或现有 registry makeDb）：`POST 注册 → PATCH false → POST token 403 → GET /api/modules 不含 → PATCH true → token 200 → 列表含`。约 40 行，直接覆盖「启停秒级生效免重部署」的决策 #15 语义。
2. 侧栏 UI 层：在引入组件测试（@vue/test-utils + happy-dom，shell devDeps 缺）后补一例；在此之前 nav.test.ts 数据面已是最低成本覆盖。

---

### A8. 冒烟检查（smokeCheck 等） —— 零测试；九步测试用注入口整体绕过了真实实现

**覆盖现状**
- `deploy/cloudflare/test/` 无 smoke 相关测试文件；`smoke.ts` 三个导出全部零测试：`fetchSetupToken`（18-41）、`smokeCheck`（43-84）、`parseWorkersDevFromDeployOutput`（86-89）。
- `steps.test.ts` 的九步用例全部通过 `http:` 注入口绕过真实冒烟：SMOKE_OK 假实现（`steps.test.ts:78-86`）返回硬编码 `ok:true`；`steps.ts:232-240` 选择 `input.http ?? fetchSetupToken/smokeCheck`——**真实 smokeCheck 的解析逻辑（200 + body.ok===true、HTTP 非 200 的 detail、超时 AbortSignal、不可达 catch、moduleSubdomain 目标拼接）从未被任何测试执行**。`runNineSteps` 只测了「编排与幂等」，冒烟本身是测试盲区。

**缺口**（smoke.ts 全部行为）
- `smokeCheck` URL 构造：`moduleSubdomain: true → https://<id>.<host>/m/<id>/api/health`、false（workers.dev）→ 主域路径——**这正是 #57 拓扑分歧所在，却零断言**；
- 各结果分支：200+ok:true / 200 但 body 缺 ok（detail='响应体缺 ok:true'）/ 非 200（detail='HTTP n'）/ fetch 抛错（status 0 + 不可达 detail）/ timeout；
- `fetchSetupToken`：200 → token+setupUrl；409 → sealed；其它非 ok → 抛错；fetch 抛错 → 人话提示（DNS 污染建议）；
- `parseWorkersDevFromDeployOutput` 正则：正常 URL/无匹配→null。

**真机对应**：真机冒烟在 #15 两次跑过（workers.dev 不可达 → custom domain 后通过「core-api ✓ module:hello」），但脚本内冒烟的**失败路径**从未被真实/自动验证；`steps.ts:246-249` 的「冒烟失败 → 抛错」被 `steps.test.ts:160-171` 用假 smoke 测过（仅编排层）。

**建议补法（最低成本）**
1. 新建 `deploy/cloudflare/test/smoke.test.ts`：mock `globalThis.fetch`，表驱动覆盖上面全部分支（~10 it，含 moduleSubdomain 两种模式的 URL 断言——顺带把 #57 的「冒烟目标 = 模块真实挂载点」钉进测试）；`fetchSetupToken` 4 例；`parseWorkersDevFromDeployOutput` 2 例。纯 mock、无网络、无新依赖。
2. 可选：steps.test.ts 保留 `http` 注入口的同时，新增一条不注入 http、用 mock fetch 走真实 `fetchSetupToken/smokeCheck` 的九步用例（验证真实冒烟被编排调用、失败会中断部署）。

---

### A9. core Worker 入口（coreWorkerEntrySource SPA 回退） —— 仅字符串级；回退逻辑零行为测试

**覆盖现状**
- `assemble.test.ts:95-99`：`toContain` 两项（相对 import 路径到 `services/core-api/src/index.ts` + SPDX 头）。**不回退逻辑**：`steps.ts:327-356` 里「404 且 GET 且非 /api、/life、/.well-known → ASSETS 兜底；否则保持 JSON 404」的分支矩阵零执行测试。

**缺口**（`steps.ts:334-350` 全部行为）
- `/api/*`、`/life/*`、`/.well-known/*` 的 404 必须**保持原响应**（不落 SPA）；
- 非 GET（POST/PUT…）404 保持原响应；
- 其它 GET 404 → `env.ASSETS.fetch('/')`；
- `env.ASSETS` 缺失 → 保持原响应；非 404（如 500）→ 直接返回。
- 与 A4 的联动：该回退恰是「主域 /m/<id>/ 被壳 SPA 200 兜底」的 worker 侧路径（另一条是 assets 层的 not_found_handling）——两路径都无测试。

**真机对应**
- PR #53 / df9693e：「core 入口只 app.fetch 无 ASSETS 兜底：页面导航在 Hono 无路由 → text/plain 404。生成注释与实现不符。现 404 且 GET 且非 API 路径 → 回退 SPA；API 404 保持 JSON。」——修复点 = 本面全部逻辑，当前无任何测试能防其回归（且当时 comment 声称有兜底、实现没有——字符串级测试看不出来）。

**建议补法（最低成本）**
1. 把回退判定抽成纯函数 `decideSpaFallback(res: {status}, pathname, method)`，表驱动断言（~10 行数据驱动）。模板保持胶水。
2. 次选：把生成的入口写到临时文件、stub 一个 `app.fetch`（返回 404 JSON）重定向 import，用 `env.ASSETS` mock 直接调 `default.fetch`——不依赖 workerd。

---

### 附带发现（非九面，标注为溢出观察）
- §6.5/决策 #22 的「request id 串联排查」：全仓**没有生成** `x-request-id` 的代码——`modules/hello/src/index.ts:32,42,…` 与 shell 各 lib 只**回读/透传**该头；core-api 无 onError 中间件、不设该头。`App.vue:245/283`、`SetupView.vue:185` 的错误卡 requestId 恒为 undefined。属「功能缺口」而非测试缺口，已真机暴露面，建议记入 M1 或 #45。
- `assemble.ts:295` wrapper 模板头注释「绝对 URL 头重写」与实际实现不符（无头重写代码）——注释漂移，建议随 A3 修复一并对齐。

---

## B 节：用户对测试设计的原始要求挖掘

### 未找到的明文
**用户就「测试怎么才算测过」的原始原话：未找到。** 在 issue/PR 讨论中可检索到的用户署名内容（「设计拍板（用户…）」「用户反馈」「用户要求」），全部集中在**部署形态/域名/产品决策**方向（#54 换绑 unself.demo.handywote.top、#53 /setup 404 反馈、#57 B 方案拍板），没有一条是关于测试方法、测试覆盖率或「防两张皮」的明文要求。上述「两张皮」「单测证不了契约」等表述全部出自 HandyWote（代理）对真机事故的复盘记录，不是用户原话——不冒充用户要求。

### 可引用的要求线索（原文 + 出处）

| # | 原文（摘） | 出处 |
|---|---|---|
| 1 | 「测试随类型更新（icon 字段合法/非法/缺省用例）」 | issue #1 正文（验收随代码走） |
| 2 | 验收标准大量为**真机型**：「验收：curl JWKS 拿到真公钥；jose 可用其验签」；「真实 Stalwart/Keycloak 账号浏览器登录成功，刷新不掉线」；「同一链接第二次使用被拒」；「空 CF 账号连跑两次结果一致」；「关 hello 边栏即消失、直访 /m/hello/ 领不到新 token；重开恢复」；「计数 +1 刷新持久」 | issue #2/#5/#6/#14/#12/#13 正文——**「测试过 = 单测 + 真机验收双轨」是每个 issue 的隐含标准** |
| 3 | 「单测 24 个全绿证不了 CLI 契约」「#14 的录制型 fake 按 wrangler v3 时代 CLI 形状建模，wrangler 4.129 实际参数面已漂移」 | PR #50 正文（代理自供：单测与真实工具契约之间的缺口） |
| 4 | 「单测的内存假 D1 只认 SQL 子串、行结构自带该列，两张皮掩盖了真实列集合（56 用例全绿照样炸）」 | issue #55 评论 / PR #56（代理自供：假 D1 与迁移 DDL 两张皮） |
| 5 | 「fix 实施：entry 生成回归主域路径、wrangler 配置改 zone 路由、凭证流程加 API Token 输入、**smoke/测试同步**」 | issue #57 评论（用户 2026-09-08 拍板 B 方案，修复范围明确含「冒烟与测试同步」） |
| 6 | 「M0 = hello 模块七步验收剧本」「Vitest」 | docs/requirements.md 行 136（决策 #16） |
| 7 | 七步剧本明确定义：「部署出 setup 链接 → 首个管理员登录 → 动态边栏出现 hello → iframe 握手拿模块 token → 后端 JWKS 验签并经 SDK 读写前缀表 → 启停秒级生效 → 移除模块重部署后路由消失」 | docs/requirements.md 行 207（§8） |
| 8 | 「剧本逐条录结果：部署→setup→登录→边栏→握手/token→验签+读写→启停→移除重部署」「验收：七步全绿截图/记录入库」 | issue #16 正文（M0 验收 = 真机记录，非 CI） |
| 9 | 「验证三件套缺一不可：pnpm -r typecheck && pnpm -r test && pnpm -r build」「实现 + 单元测试」 | AGENTS.md（仓库规约，会话工作流） |

### 可推定的隐含标准（不冒充明文）
1. **双轨制**（由 #2/#8 推定）：每 issue 的「验收」= 单元/组件测试 + 真机（或真实 CLI/账号）验证；单测被历史证明**不足以覆盖**真实工具契约（wrangler 4.x、D1 DDL、workerd 运行时）。
2. **七步剧本是最终验收真值**（决策 #16 + #16 + requirements.md:207），但它**不在 CI**：`.github/workflows/ci.yml` 只跑 typecheck/test/build——剧本依赖真实 CF 账户/IdP，合理不进 CI；隐含要求是「剧本是文档化手工验收，每次 M0 交付按条录结果」。
3. **防两张皮**（由 #4 推定）：凡是「测试替身（假 D1/fake CLI）」模拟的外部契约，必须有至少一处对照真契约（真 SQLite 执行迁移、对 config-schema 校验、dry-run 真 wrangler）——这是 M0 事故史反复证明的必要性，也是本报告 A1/A2/A8 补法的立项依据。
4. **修复必须带测试同步**（#5 用户拍板原话「smoke/测试同步」）：任何部署拓扑/契约修复（#57 B 方案）落地时，对应测试与 smoke 必须同 PR 更新——当前 #57 修复实施在即，A4-1 的红测建议正对应此要求。

### 结论
- 用户**无**「测试怎么才算测过」的书面明文；但通过决策 #16（Vitest + 七步剧本）、issue #2-16 的真机验收标准、#57 拍板的「smoke/测试同步」可以稳定推定上述四条隐含标准。
- 若需用户签名确认，建议在 #57 修复会审时一并抛出「双轨制 + 真契约对照测试」的验收定义，请用户书面确认——**这是 B 节唯一需要向用户确认的事项**，其余均已从既有材料推定且标注了出处。

---

## 附录：九面「零/弱覆盖」速查表

| 面 | 覆盖级别 | 真机事故 | 建议最低成本补法 |
|---|---|---|---|
| A1 迁移↔查询 | 零 | #56 幻影列 500 | node:sqlite 执行迁移 + D1 适配器驱动查询函数 |
| A2 wrangler 配置语义 | 字段级 | #15/#50 CLI 契约、#51/54 custom_domains 形态、#53 /setup* | 整对象 toEqual + config-schema.json ajv 校验（+ 可选 dry-run） |
| A3 wrapper | 字符串级 | #52 worker.fetch、#58 资产分支×2 | 抽纯函数表驱动（或临时文件 import 真执行） |
| A4 iframe 拓扑 | 纯函数级 | #57（OPEN）主域路径 SPA 兜底 | 三方一致性红测 + attachModuleBridge/fetchModuleToken 单测 |
| A5 OIDC 全流程 | 函数级 + 单链路由级 | #44 activate 持久化落空 | 路由级失败态用例（坏签名/JWKS 500 → 人话） |
| A6 setup 时序 | 主链面全，并发/TOCTOU 零 | #55（OPEN）激活死循环 | consume 改单语句原子化 + 并发用例；#55 修复后补回归 |
| A7 启停传播链 | 环节级 | 无专项 | 一条链测试（toggle→token→列表） |
| A8 冒烟 | 零 | 真机只走过通过路径 | smoke.test.ts 表驱动（mock fetch） |
| A9 core 入口 SPA 回退 | 字符串级 | #53 text/plain 404 | 抽纯函数表驱动 |
