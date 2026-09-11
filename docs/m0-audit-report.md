# M0 审核报告（计划偏离 + 测试有效性）

- **审核对象**：`origin/m0/dev` @ `57a2d73`（工作区停在旧 main，全部证据经 `git show origin/m0/dev:…` 与 /tmp 干净副本核实）
- **真源**：docs/PRODUCT_SPEC.md（§5.1/5.2/5.3/5.5/6.5/7/8）+ docs/requirements.md 决策 #1–#26；旁证：issue/PR 讨论只读检索
- **方法与分工**：三路只读子代理并行（§5.3 偏离专项 / 测试两张皮 / 零覆盖面+issue 挖掘），主会话汇总终审；分报告存 /tmp/audit/T2-report.md、T4-report.md、T5-report.md（含全部证据原文与逐条行号）
- **范围声明**：本报告不重复子报告全文，只收口结论；主报告证据均可回溯到子报告与 git。只读审核，未改仓库任何文件。

---

## 〇、一句话总评

**M0 的实现质量在壳/契约/core-api 侧基本忠实于计划（§5.2/§5.5/§6.5 大面符合），但 §5.3 单域名路径制被部署层整体替换成 Custom Domain 子域制，且注释、日志、测试三层都在为这个偏离背书；测试侧单测面广（25 文件 ~191 用例）但与真实工件系统性脱节——假 D1 无 schema 概念、生成物只做字符串自洽断言、关键链路被注入口绕过，因此 6 次真机事故全部属于『单测全绿照样炸』类。**

- 偏离合计 **20 条**：设计级（需修订设计或用户拍板）**6 条**，实现级（实现错误/未发现）**14 条**；另有 8 条不适用/范围外项不计入。
- 测试问题合计 **24 项**：替身脱节 9（高 4 / 中 4 / 低 1）+ 空洞/脆弱 11 项（合并为 4 组）+ 零覆盖面 9（其中 6 面有真机事故对应，3 面仍无回归防线 #53/#54/#56 类）。
- 回 B 方案改动面：**代码改动集中在 deploy/cloudflare 三个文件 + 测试 + README（S/M 量级），apps/shell、services/core-api、packages、modules/hello 零代码改动**；两个待定案设计点（zone 字段形态、部署凭证文档）见 §五。

---

## 一、计划偏离清单（20 条）

> 分类：**(a)** 计划允许的机制等价替换；**(b)** 结果级偏离，需修订设计；**(c)** 违反计划至今无人发现。括号内为严重度与真机事故对应。

### A 组：§5.3 子域制偏离（6 条，系统性）

**D1【b·核心偏离】模块路由生成 = 子域 Custom Domain，非 zone 路径路由** — deploy/cloudflare/src/assemble.ts:244
`routes: [{ pattern: '${mod.id}.${config.domain}', custom_domain: true }]`。真机形态 hello.unself.demo.handywote.top 即由此而来。#57 直接根因。git 历史链：e8b1660（OAuth 10405）→ 66e8f21（routes+custom_domain 形态）→ e5df996/57a2d73（子域制症状补丁）。

**D2【c·讽刺】部署文档写路径制，部署代码写子域制** — deploy/cloudflare/README.md 步骤④「route = <domain>/m/<id>/*」、根 README.md:20「/m/<模块id>/* → 各模块 Worker」，与 assemble.ts:244 直接矛盾；无任何 PR/issue 提出过这一矛盾 → (c) 最强证据。

**D3【b】buildManifestSnapshot 的 entry 与部署拓扑脱节（#57 机制）** — deploy/cloudflare/src/registry.ts:45
`entry: '${host}/m/<id>/'`（主域路径 URL）vs 实际挂载在子域 → 壳按 entry 装 iframe → 主域 /m/hello/ 被 core SPA 200 兜底接走（issue #57）。注：entry 生成本身是路径制的**正确**实现，B 方案下无需改；当前错在运行时拓扑。壳侧消费链（registry-api.ts:60-67 → App.vue iframe :src）为路径制正确实现。

**D4【c】wrapper 是「路径制代码在子域制运行」的缝合怪** — assemble.ts:295-330 prefixStripWrapperSource
在子域制下它剥的是一个**不存在的路径前缀**：真实请求 `/api/count` → `isAsset` 恒真（assemble.ts:306-307）→ `slice(PREFIX.length + 1)` 错位切片 → `ASSETS.fetch('/unt')` → 404，**模块 API 永不可达**（#56）；页面相对引用解析为无前缀 URL 同样落入错位切片（#58 的延伸）。只有幽灵形态 `https://hello.<host>/m/hello/...`（子域 host + 路径 path）能被它正确处理——而这个形态不存在于任何真实访问路径。#56/#58 同源于此。

**D5【c】冒烟探测的是幽灵 URL——冒烟全绿证明不了链路通** — deploy/cloudflare/src/smoke.ts:43/48-49/56-57 + steps.ts:243-244
`moduleSubdomain: Boolean(config.domain)` 把「配置了域名」等价「子域制」；探测 `https://<id>.<host>/m/<id>/api/health`（子域 host + 路径 path 混合）。这是唯一能被 wrapper 正确处理的 URL 形态，因此**冒烟测试恰好绕过了真机所有断点**。#56/#57/#58 全部发生在冒烟测不到的路径上。steps.ts:180/198 日志「绑 /m/<id>/* 路由」与实现不符（对验收者撒谎）。B 方案下此 flag 必须删除，否则冒烟 404 部署必败。

**D6【c】注释层把偏离固化为设计事实**（5 处）— assemble.ts:191-192（「10405 的修复=custom_domain」且不提模块路由本应走 zone 路径）、assemble.ts:298（「绝对 URL 头重写」——模板内无任何 header 重写代码）、registry.ts:44（「部署后…同域路径制 §5.3」——与实现**相反**）、smoke.ts:43（「custom domain 模式下模块在 <id>.<域名>（子域式）」）、steps.ts:243（「与 custom_domains 绑定一致」）。

### B 组：其余契约偏离（8 条）

**D7【b】§5.2 登出广播未实现** — packages/contracts/src/messages.ts（SdkMessageSchema 无 logout 类型）；module-sdk client.ts 无丢弃 token 处理；core-api index.ts:198 注释自认「§5.2 壳广播登出消息给模块由 shell 完成」但壳未广播。缓解：登出整页跳转销毁 iframe 上下文。建议 M0 补 `{type:'logout'}` 契约 + 广播 + SDK 停循环（S）。

**D8【b】决策 #22 request id 半实现** — 壳侧三处消费 x-request-id（registry-api.ts:39、setup-api.ts:29、token-api.ts:38 → UErrorCard），**core-api 全源码 0 处产出**该头（grep 证实），requestId 恒 undefined，异常卡 request-id 展示是死功能。§6.5「成员只见人话+request id」交付面缺口。

**D9【c】§6.5 tokens.css 单源违规** — modules/hello/src/index.ts:73-92 页面内联样式含裸 hex（`--bg:#ffffff`、`#fff`、`#dc2626` 等）。§6.5 明文适用于「一切自研模块前端」。属于执行遗漏，成本 S。

**D10【c】§6.5 系统字体栈未定义** — tokens.css 无 font-family 令牌，shell 无全局字体声明（styles.css 仅一行 @import tailwindcss）；仅 hello 页内联 system-ui。spec 要求「系统字体栈」，壳本体反而没设。

**D11【c】决策 #10 SPDX 头遗漏** — apps/shell/src/styles.css 无 `// SPDX-License-Identifier: AGPL-3.0-only` 头（全仓唯一缺头源码文件）。成本 S。

**D12【b/a】决策 #14 微不一致：export 与实际存储两张皮（源码级）** — modules/hello/src/index.ts:300-319 `/life/export` 输出 `tables.hello_counter`，但计数实际读写全在 module_kv（index.ts:47-62）；`hello_counter` 表（migrations/hello/0001_init.sql）**从未被写入**，export 声称导出一张空表、purge 清的是另一张。M1 卸载剧本数据源。归 b（契约语义漂移需修）或接受为骨架占位（a），需拍板。

**D13【c】UNSELF_BASE_URL 死配置** — assemble.ts:215 生成 `UNSELF_BASE_URL` var，全仓无消费者。

**D14【c】SDK「子域」术语撞名 DNS 子域** — module-sdk/src/storage.ts:4/46/58、hello/src/index.ts:23 等处「模块子域」指数据命名空间（module_id 收口），与本次真机事故核心概念（DNS 子域）撞名，正是注释误导传播的土壤。建议改称「模块作用域」。术语级，S。

### C 组：范围外/不适用/待拍板（8 条，不计入偏离总数）

| 条款 | 状态 |
|---|---|
| §5.5 一键入口（Deploy 按钮 + Workers Builds） | 未实现，M0 交付 CLI——建议明示为范围外 |
| §5.5 Docker 等价 / 决策 #3 | 不适用（M0 无 deploy/docker） |
| §5.2 停用踢人广播（lifecycle 钩子） | 不适用（M0 无成员停用功能），token 10min 兜底存在（token.ts:88-105） |
| §5.2 外部 SLO | spec 自标远期 |
| 决策 #14 模块 KV = 共享表 module_kv + module_id 列 | 等价替换，migrations 0001_module_kv.sql 注释自论证，SDK 收口实现正确 → (a)，建议终审追认 |
| 决策 #14 微不一致（与 D12 同源） | 见 D12 |
| §6.5 「无首页」与 nav 恒有「工作台」项 | 解释性张力，M0 动线（直访落模块）绕开，不判定 |
| beUI→shadcn 查找序执行过程 | 仅 packages/ui/src/index.ts 声明可查，过程无法独立核实（不判定） |

### B 组：其余契约逐条符合面（抽样证据，完整表见 /tmp/audit/T2-report.md B 节）

**符合良好**：§5.1 manifest schema（contracts/manifest.ts：route 前缀/entry z.url()/icon [a-z0-9-]/emoji 拒绝有反例测试）；§5.2 token 形态（aud=模块 id、10min、kid+JWKS、sub=内部 uid、postMessage 双向 origin 校验，token.ts:7-8/52-54 + module-bridge.ts + client.ts:117-119）；§5.2 setup 一次性 token（生成/消费/封死/409 链完整）；§5.5 九步齐全、unself.config.jsonc 唯一配置（zod schema）、幂等收敛（steps.test 二跑零 create/零 secret put）、运行时不持 CF 凭证、OIDC 不进配置文件；§6.5 基元住 packages/ui、Lucide 禁 emoji（全仓无 emoji 图标）、220px 左栏+窄屏标签栏、setup/登录动线、中文写死、亮色单主题；决策 #1/4/5/9/12/16/19/20/21 符合。

---

## 二、测试问题清单（24 项）

> 每项：位置 → 脱节 → 放过的真机 bug → 补法。详细证据与剩余 7 项空洞断言清单见 /tmp/audit/T4-report.md、T5-report.md。

### 2.1 测试替身与真实工件『两张皮』（9 处）

**T1【高】core-api 四套假 D1 全部无 schema 概念** — registry.test.ts:31-80、setup.test.ts:14-77、token.test.ts:9-45、auth-routes.test.ts:74-86
SQL 子串匹配（`sql.includes('FROM module_registry')`）→ 命中即返回**手造行**；`run()` 对未识别 SQL 一律 `{success:true}`；无一处加载真实 migrations/core/*.sql。真迁移列集合（users/module_registry/acl/audit_log/instance_config/setup_tokens/oidc_flows）与假行结构逐表有出入（registry 行曾自带幻影 registered_at；setup 行 used_at 用 ISO 而真表 datetime('now')；token.test 假 users 查找语义与 requireAdmin 实际 SQL 不符；auth-routes 的 JIT INSERT 全被吞）。→ **放过了 #56（幻影列 500，已证实）**；仍会放过：UNIQUE 约束违反、INSERT 列名/NOT NULL 违约、SQL 方言错、未来 acl 表接入即假绿。**补法：统一 test-utils = node:sqlite（Node 内置，本机已验证可用，零新依赖）加载真实 migrations 建表 + 40 行 D1 适配器，替换 4 处假 D1。**

**T2【高】buildManifestSnapshot 逐行正则读不了 YAML list——requires/capabilities 从未被解析，测试『共谋』掩盖** — deploy/cloudflare/src/registry.ts:21-48 vs modules/hello/manifest.yaml（requires/capabilities 为 list 形式）
`requires:` 无值被跳过、缩进 `- identity` 不匹配 `^key:` 正则 → 快照硬编码 `requires:['identity']`/`capabilities:['demo']`（registry.ts:47-48），与 manifest 内容无关。测试 HELLO_MANIFEST 的实际值恰好等于硬编码默认值 → 断言恒真。→ **潜在放过：模块声明自定义 capabilities（如 ['counter']）时，注册表快照仍写 ['demo'] → capsFromManifest（token.ts:98-107）签发错误 caps → token 能力授牌错误，无测试会红**（hello 恰好又是 demo/counter 边缘重合）。**补法：测试喂「非默认值 list 形式」manifest 并全字段断言快照（立刻红）；随后正则换最小 YAML 解析。**

**T3【高·静态推断】hello 页面 import 的是 IIFE 产物——真机模块白屏风险** — modules/hello/src/index.ts:111 `import … from './sdk/module-sdk.js'` vs assemble.ts:125-149
module-sdk.js 打包为 **IIFE**（无 ESM 导出），同目录另有 module-sdk.esm.js（ESM 版）；装配注释自认「IIFE 全局名不足以满足具名导入——因此资产侧提供 ESM 版」，但页面 import 未指向 .esm.js。浏览器 `import {createModuleSDK} from <IIFE>` 将 SyntaxError。→ **潜在放过：真机 iframe 白屏（#58 同类『装配产物↔页面契约』坑）**。五层测试无一回答「import 路径是否命中 ESM 且存在」；hello.test:196-201 反而把该路径固化为断言。**补法（二选一，S）：装配后断言 sdk/module-sdk.js 含 export 语法；或页面 import 改 .esm.js 并断言产物存在。未真机验证，排第一优先核实。**

**T4【高】r2 bucket list fake 喂 JSON、真机是文本** — steps.test.ts:59-62 vs provision.ts:63-76
真机 wrangler v4 输出 `name: <桶名>` 文本，fake 只生产 JSON → 真实解析分支零测试。→ **潜在放过：格式一变每次部署都重复 create bucket → 真机报 already exists**（ensureR2Bucket 也无 ensureDatabases 式回查自愈）。**补法：fake 改喂真实文本格式 + 一条文本解析直测。**

**T5【中】假 Wrangler 对 migrations/execute 全盘接受** — steps.test.ts:37-40「接受一切」→ okOut('')
记录了命令序列，但 SQL 合法性、配置 schema、迁移目录存在性全无校验。→ **放过了 5 连真机事故里的 4 个**（#50 CLI 契约 13 项、51/54 custom_domains 两形态、#53 /setup*——其中 #53 与 57a2d73 的 wrapper 修复**只改 src 测试一字未动**，至今无回归防线）。**补法：生成物整对象 toEqual + 对 wrangler config-schema.json 做 ajv 校验（+可选 dry-run）；d1 execute SQL 过 node:sqlite PREPARE。**

**T6【中】x-request-id 契约全线空转** — 壳侧消费（见 D8）+ setup-api.test.ts:31-35 把 headers.get 桩成恒 null
测试既测不出「core-api 根本没这头」，也无法对齐未来补头。→ **放过了 D8 死功能**。**补法：core-api 加中间件产出 x-request-id + 一条壳↔端契约测试。**

**T7【中】module-sdk verifyModuleToken 真实验签链路零测试** — sdk.test.ts:266-278 仅一条垃圾输入用例；全仓无一处测 RemoteJWKSet（kid 选钥）路径；hello 用自建 JWKS fetch 绕过量产函数。**补法：mock fetch JWKS 端点 + 真 ES256 走 happy/aud 错/过期 三条（复用 oidc.test 的 installFakeIdp 模式）。**

**T8【中】storage.test 假 D1 替被测代码『背锅』** — storage.test.ts:29-101 MemoryStatement 恒用 params[0] 当 moduleId 过滤
SDK SQL 若漏写 `WHERE module_id = ?`，fake 仍会正确过滤 → **测试绿、真机跨模块数据泄漏**（module_kv 为全模块共享表，数据越权级）；LIKE 正则重写与 SQLite 真实语义有偏差；PK(module_id,key) 被删时测试无感。**补法：同 T1 用真 SQLite；至少加「SQL 文本含 module_id = ?」断言。**

**T9【低】假 IdP 的固有边界 + 两处 sanitizeNext 无测试** — oidc.test 假 token endpoint 不验 code_verifier（假 IdP 无法测 PKCE 服务器侧）；core 侧 sanitizeNext（index.ts:262-267）与壳侧 landing.ts 无 `////`、`/\` 变体用例（潜在开放重定向，低置信）。**补法：变体用例 + 换 origin 判定。**

**正面澄清（避免误伤）**：oidc/auth-routes 的假身份源是真 RS256 密钥 + 真 jose 验签 + fail-closed 全覆盖（15 it），是全仓测试范本，**没有绕过验签**；迁移文件与当前源码 SQL 列集合经逐条比对一致（#56 修复后状态）。

### 2.2 空洞/脆弱断言（11 项合并为 4 组，全清单见 T4 报告附录）

- **G1 恒真/自证**：ui.test.ts 全文件（导出存在性+版本号恒真）；sdk.test.ts:118-124 无 window no-op 恒真；hello.test.ts:165-170 断言的是测试自己的 fixture（自证循环）；token.test.ts:154-167「已停用模块在启停后可再取」用两个独立 makeDb——**不是同一 DB 状态的翻转**，用例名与行为不符（未证实同一 DB 翻转语义别处已覆盖，标注存疑）。
- **G2 子串包含族**：assemble.test.ts:27（run_worker_first 只 toContain '/api/*'——**#53 修复点 /setup* 至今零断言**）；assemble.test.ts:81-93 wrapper 三连 toContain（#58 修复对象零行为断言）；registry.test.ts:88/116-118。
- **G3 各测各的、互相矛盾**：provision-registry.test.ts:47-49 断言 entry=主域路径，assemble.test.ts:55-58 断言路由=子域——**两条测试各自绿，合起来就是 #57**；assemble.test.ts:55 用例标题「route 绑定 /m/<id>/*」与断言内容（子域）不一致。
- **G4 绕过被测行为**：steps.test.ts 经 `http:` 注入口（steps.ts:232-240）**整体绕过真实 smokeCheck/fetchSetupToken**——冒烟解析逻辑零测试；SMOKE_OK 假实现写死全绿。

### 2.3 关键面零覆盖（9 面，全表见 T5 报告附录速查表）

| 面 | 覆盖 | 对应真机事故 | 状态 |
|---|---|---|---|
| 迁移↔查询一致性 | **零** | #56 | 无回归防线 |
| wrangler 配置语义 | 字段级/子串 | #50/#51/#54/#53 | #53/#54 无防线 |
| wrapper 生成物行为 | 字符串级 | #52/#58 | 无防线 |
| iframe 装载三方一致性（entry↔route↔smoke） | **零** | #57（OPEN） | 无防线 |
| OIDC 全流程 | 函数级充分，路由级失败态零 | #44 | activate 已补，callback 失败态仍裸奔 |
| setup token 时序 | 主链全，**TOCTOU 并发零** | #55（OPEN） | consumeSetupToken 两步非原子（setup.ts:55-68） |
| 启停门禁传播链 | 环节级，无链路测试 | 无专项 | — |
| 冒烟 smokeCheck | **零** | 事故全从冒烟盲区穿过 | 无防线 |
| core 入口 SPA 回退 | 字符串级 | #53 | 无防线 |

附带：attachModuleBridge（壳侧桥安全路径）、token-api.fetchModuleToken、App.vue/router 组件层、smoke.ts 三导出，全部零测试；shell 无 @vue/test-utils/jsdom devDeps。

### 2.4 用户对测试的设计要求（挖掘结论，未编造）

- **明文要求：未找到。** issue/PR 里可检索的「两张皮」「单测证不了 CLI 契约」等复盘表述全部出自代理（HandyWote）之手，非用户原话；用户署名内容集中于域名/部署/产品拍板（#53/#54/#57）。
- **可引用线索**：issue #1「测试随类型更新」；决策 #16（Vitest + 七步剧本）；issue #2/#5/#6/#12/#13/#14/#16 的验收标准全部是**真机型**（curl JWKS 验签、真 Stalwart 登录、空账号连跑两次、同链接二次拒绝、边栏消失/恢复）；AGENTS.md「验证三件套缺一不可」；**#57 用户拍板原话「smoke/测试同步」**——这是唯一一条用户明文给出的测试相关要求，且当前未落实（#57 未修，测试未同步）。
- **推定隐含标准**（建议正式化）：① 双轨制 = 单测 + 真机验收；② 七步剧本是最终真值但不进 CI（依赖真账户/IdP），须按条录结果入库（#16）；③ 凡测试替身模拟的外部契约（D1 DDL/wrangler CLI/workerd），必须有至少一处对照真契约的测试；④ 拓扑/契约修复必须同 PR 带测试与冒烟同步。

---

## 三、回 B 方案（Workers Routes zone 路径路由 + API Token）改动面清单

| # | 文件 | 改动 | 量级 |
|---|---|---|---|
| 1 | deploy/cloudflare/src/assemble.ts | moduleWranglerConfig L244：routes 改 zone 路径 pattern `team.example.com/m/<id>/*`（去 custom_domain，**需 zone 标识，见待定案 1**）；core 主域 custom_domain 保留（L191-193 可不动）；改写 L191-192 与 L298 注释；wrapper 本体**零改动**（B 下前缀真实存在，57a2d73 空路径分支变冗余无害） | **M** |
| 2 | deploy/cloudflare/src/smoke.ts | 删 moduleSubdomain 参数及分支（L43/48-49/56-57），探测回归主域路径 | **S** |
| 3 | deploy/cloudflare/src/steps.ts | L243-244 删 `moduleSubdomain: Boolean(config.domain)`；步骤④日志随之成真 | **S** |
| 4 | deploy/cloudflare/src/config.ts + unself.config.jsonc | 待定案 1：config 是否增 `zone` 字段（多级子域域名无法从 domain 推断 zone，如 demo.handywote.top ∈ handywote.top）；样例补注释 | **S** |
| 5 | deploy/cloudflare/test/assemble.test.ts | L55-67 断言改 zone 路径 pattern；补 module assets 块/run_worker_first 全量/jwksUrl 分支断言；wrapper 行为测试（A3 补法） | **M** |
| 6 | deploy/cloudflare/test/provision-registry.test.ts / steps.test.ts | entry 断言已路径制不动；新增 smoke.test.ts（真实 smokeCheck 两模式 URL 断言）；三方一致性红测（T5 A4-1，HEAD 上红、修复后转绿——精确把 #57 钉进 CI） | **M** |
| 7 | deploy/cloudflare/README.md | 补部署凭证段：API Token（Workers Routes/D1/R2/Scripts 权限清单）替代 wrangler login；10405 背景 | **S** |
| 8 | apps/shell、services/core-api、packages、modules/hello | **零代码改动**（壳侧/契约层全为路径制正确实现，B 下自动归位） | — |
| 9 | 真机重验 | API Token 重部署 unself.demo.handywote.top；#56/#57/#58 三链闭合验证；冒烟 URL=主域路径；七步剧本按条录结果 | **L**（工作项） |

**总评**：B 方案是**减法**——删除 moduleSubdomain 分支与幽灵 URL 形态，wrapper 恢复设计本义，壳侧零改动即全链对齐；主要新增面是凭证文档与 zone 字段定案。

---

## 四、防『两张皮』最低成本补测机制（汇总建议）

1. **真迁移建表**：node:sqlite（零依赖，Node≥22）加载 migrations/*.sql + 最小 D1 适配器（~40 行），替换 core-api 4 处 + hello/storage 的假 D1 → 一次性消灭 T1/T8 同款脱节（对应 #56）。
2. **生成物语义断言**：wrangler jsonc 整对象 toEqual + 对 node_modules/wrangler/config-schema.json 做 ajv 校验；可选 `wrangler deploy --dry-run` 进 CI → 拦 #50/#54/#53 类契约漂移。
3. **三方一致性红测**：config → entry 生成 → route 生成 → moduleFrameSrc 同吃一个测试，断言「iframe 装载点 == 模块路由点 == 冒烟探测点」→ 拦 #57 类拓扑分裂（HEAD 上即红）。
4. **wrapper/入口抽纯函数 + 表驱动**：isAsset 判定矩阵、SPA 回退判定矩阵各 ~15 行测试 → 拦 #52/#58/#53 类。
5. **部署后冒烟固化**：真实 smokeCheck（非注入口）纳入九步集成测试（mock fetch）；CI 全绿外保留七步剧本真机验收为发版门禁，按条录结果入库（决策 #16/#57「smoke/测试同步」落实）。

---

## 五、优先级（修复成本 × 风险）

| P | 事项 | 成本 | 风险消减 |
|---|---|---|---|
| **P0** | 立即核实 T3（页面 import IIFE 产物）——真机打开 hello 页或 workerd 本地一验 | 10 分钟 | 潜在模块白屏 |
| **P0** | 回 B 方案主体改动（§三 #1-#3+#5-#6，含三方一致性红测与 smoke 补测随 PR 落地，兑现「smoke/测试同步」） | 1-2 天 | 关闭 #57；消灭冒烟盲区；建立 #56 类防线 |
| **P1** | 真迁移建表 test-utils 替换假 D1（T1/T8） | 0.5-1 天 | 拦住下一枚 #56 |
| **P1** | buildManifestSnapshot 非默认值 list manifest 红测（T2） | <1 小时 | 拦 token caps 授牌错误 |
| **P1** | deploy 凭证切 API Token + 文档化权限清单（§三 #7，用户已拍板） | S | 解 10405 根因 |
| **P2** | consumeSetupToken 原子化 + 并发用例（#55 修复前置）；#55 死锁链路红测 | S | 拦 TOCTOU 双提升 |
| **P2** | core-api x-request-id 中间件（D8/T6）；OIDC callback 失败态路由级用例 | S | 补 #22 交付面 |
| **P2** | assemble 断言补全（/setup*、module assets、jwksUrl 分支）+ r2 fake 文本格式（T4/T5） | S | 契约漂移防线 |
| **P3** | 卫生项：hello 内联裸 hex 迁 tokens、字体栈令牌、styles.css SPDX 头、UNSELF_BASE_URL 删除、「子域」术语改「作用域」、wrapper 注释失实修正 | 各 S | 防再次误导 |
| **P3** | 设计拍板：D12（export/purge 表自洽）、登出广播契约（D7）、module_kv 等价替换追认 | 会议级 | 契约完整性 |

---

## 六、无把握处声明（如实）

1. T3（IIFE import 失败）为静态推断，未在真机/workerd 复现；存在 wrangler assets 意外行为的可能，已列 P0 核实项。
2. zone 路径路由在 wrangler v4 的确切配置形态（zone_id/zone_name 字段写法）未在本仓库验证；10405 的解除以「凭证换 API Token」为用户拍板方向，代码层 wrangler.ts 不写死认证方式（wrangler.ts:35），理论无需改，待真机验证。
3. beUI→shadcn 组件查找序的执行过程仅有结论性声明可查，无法独立核实（不判定）。
4. L4 开放重定向变体（////、/\）的浏览器解析行为未实测，低置信标注。
5. 「OIDC 全流程含真 IdP」无自动化属合理边界（外部依赖），现状由 #16 真机验收覆盖，建议文档化手工步骤而非强行 CI 化。

---

*分报告：/tmp/audit/T2-report.md（偏离专项+契约对照全表）、/tmp/audit/T4-report.md（两张皮 9 处+空洞 11 项全证据）、/tmp/audit/T5-report.md（九面覆盖+用户要求挖掘）。审核过程零仓库写入、gh 仅只读。*
