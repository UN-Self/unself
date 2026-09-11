# T4 报告 · M0 测试替身『两张皮』排查

- 审计对象：`origin/m0/dev` @ 57a2d73（经 `git archive` 抽到 /tmp/audit/wt-2，仓库零写入）
- 范围：24 个 `.test.ts`，共 3422 行；比对真实工件 = 5 个迁移 SQL + 各包 src（core-api / shell / module-sdk / hello / deploy）
- 方法：只读源码；「已证实」项均用只读 `git show` 核实过 commit 内容；「潜在/静态推断」一律标注
- 结论基调：**OIDC 假身份源部分（oidc/setup/auth-routes.test）质量是全仓最好的，没有绕过 jose 验签**；真正的脱节集中在四类——假 D1 无 schema 概念、manifest 手写正则解析、wrangler 配置断言只测源码自洽、壳↔端契约无跨端测试。

---

## 一、严重度排序的脱节点

### 🔴 高

#### H1. core-api 四套假 D1 全部「无 schema 概念」——SQL 不执行、行结构手造（已证实放过 1 个真机 bug，同款脱节仍会再犯）

涉及文件（每处假 D1 的实现方式）：

| 文件:行号 | 实现 | SQL 匹配方式 | 返回行来源 |
|---|---|---|---|
| services/core-api/test/registry.test.ts:31-80 | `makeDb()`：Map 后备，无任何 CREATE TABLE | 子串 `sql.includes(...)`（5 个 SQL 族） | 手造 Map 行 |
| services/core-api/test/setup.test.ts:14-77 | `makeDb()`：Map 后备 | 子串 + `sql.startsWith(...)` | 手造 Map 行 |
| services/core-api/test/token.test.ts:9-40 | `makeDb()`：数组 findBy | 子串 | 测试喂的行对象 |
| services/core-api/test/auth-routes.test.ts:74-84 | `env()`：**恒空 stub**（first→null / all→[] / run→一律 `{success:true}`） | 不识别任何 SQL | 无 |

脱节描述：
- 假 schema 是「TS 类型 + 构造函数里的 Map/数组字面量」，**与真实迁移零关联**。没有一处加载过 `services/core-api/migrations/core/0001/0002/0003`。
- `run()` 对**未识别的 SQL 一律返回 `{success:true}`**（registry.test.ts:65-71 的 if/else 链没有兜底分支，末尾固定 success；setup/token 同款）——任何新增 INSERT/UPDATE（如未来写 `acl` 表）在测试里静默成功。
- 假行结构与真表列集合的偏差（逐处）：
  - registry.test：`_users` 行缺真表 `users` 的 `created_at`；`_audit` 缺 `id/actor/created_at`；**没有** `acl / instance_config / setup_tokens / oidc_flows` 的概念（查询这些表 → first→null / all→[] / run→假成功）。`module_registry` 行结构已与修复后的真列集合一致（这是 PR #56 修复时被动对齐的）。
  - setup.test：`setup_tokens.used_at` 用 `new Date().toISOString()` 而真表写 `datetime('now')`（格式语义不同）；`instance_config` 无 `updated_at`；`users` 只存 `{role}`。
  - token.test：`FROM users` 分支按 `(issuer, sub)` 双参查找，与真实 `requireAdmin` 的 `SELECT role FROM users WHERE id = ?` 单参语义不符（当前 token 路由没用 requireAdmin，属潜伏错位）。
  - auth-routes.test：JIT 建档 `upsertUser` 的 `INSERT INTO users (id, issuer, sub, display_name, role)`、`promoteToAdmin` 的 UPDATE、`audit`——全部被恒空 stub「成功」吞掉。

对应真实工件：
- services/core-api/migrations/core/0001_init.sql：`users(id PK, issuer NOT NULL, sub NOT NULL, display_name, role NOT NULL DEFAULT 'user', created_at NOT NULL DEFAULT datetime('now'), UNIQUE(issuer,sub))`、`module_registry(id PK, enabled INTEGER NOT NULL DEFAULT 0, version, manifest_json TEXT NOT NULL)`、`acl(resource,user_id,perm ×PK)`、`audit_log(id INTEGER PK AUTOINCREMENT, actor, action, target, created_at DEFAULT)`
- 0002_setup_oidc.sql：`instance_config(key PK, value NOT NULL, updated_at DEFAULT)`、`setup_tokens(token PK, created_at DEFAULT, used_at, used_by)`、`oidc_flows(state PK, payload_json NOT NULL, created_at DEFAULT)`
- 0003_registry_index.sql：`idx_module_registry_enabled (enabled, id)`

放过的真机 bug：
- **已证实**：`registered_at` 幻影列（PR #56 / commit d675757）——旧假行结构自带 `registered_at`，`listModules` 的 `SELECT ... registered_at` 在测试里「有列可返回」，上真机 D1 `no such column: registered_at` → `/api/modules`、`/api/admin/modules` 全 500；56 用例全绿。commit 同时改了测试行结构（-10 行）——**证明测试与真迁移从来没对齐过，是被 bug 牵着对齐的**。
- **潜在**：本假 D1 一族仍拦不住——① `users.UNIQUE(issuer,sub)` 在回调并发下的唯一约束违反（500）；② 任何 INSERT 列名/列序/NOT NULL 违约（auth-routes 的 JIT 建档是全仓唯一「全空 D1 上跑完整 INSERT」的路径）；③ `ON CONFLICT ... datetime('now')` 等方言语法错；④ 路由开始复用 `acl` 表时（M1 权限模型）假 D1 直接假绿。

最低成本补法：
- 测试建 schema 一律加载真实迁移：`readFile(migrations/core/*.sql)` 后喂给 `node:sqlite`（Node 22 内置 `DatabaseSync`，零新增依赖）或 better-sqlite3；替换掉 4 处假 D1 为同一个 test-utils。改动面 = 4 个测试文件的假 D1 函数 + 断言微调，收益 = 列/类型/约束/SQL 方言全部真校验。

#### H2. buildManifestSnapshot 逐行正则 vs 真实 YAML 多行 list——requires/capabilities 根本没被解析（已被测试「共谋」掩盖）

- 文件:行号：deploy/cloudflare/src/registry.ts:21-48（`manifestScalarFields` 用 `^key:\s*(.*?)(?:#.*)?$` 逐行正则），测试 deploy/cloudflare/test/provision-registry.test.ts:20-56。
- 脱节描述：真实 manifest.yaml 的能力声明是 **list 形式**：
  ```yaml
  requires:
    - identity
  capabilities:
    - demo
  ```
  行正则对 `requires:`（无值）→ m[2]==='' → 跳过；缩进的 `- identity` 行根本不匹配 `^key:`。于是 `buildManifestSnapshot` 硬编码 `requires: ['identity']`（registry.ts:47）、`capabilities: ['demo']`（:48）——**与 manifest 内容无关**。
  测试喂的 HELLO_MANIFEST（provision-registry.test.ts:20-36，实际是真实 manifest.yaml 的逐行抄写）恰好 `requires: [identity]`、`capabilities: [demo]`——与硬编码默认值完全一致，所以「断言快照通过 schema 校验」恒真，**parser 丢字段这件事被测试结构性地掩盖**。
- 对应真实工件：modules/hello/manifest.yaml（id/route/runtime/version 是标量，确实可以被该正则读到；requires/capabilities 是 list，读不到）。
- 放过的真机 bug：
  - **潜在（高）**：任何模块在 manifest 里声明与默认不同的 `capabilities`（契约允许任意字符串数组，如 `counter`/`notify`），注册表快照仍写成 `['demo']`；token 门禁的 `capsFromManifest`（services/core-api/src/token.ts:80-90）据此签发 `caps` —— **token 能力授牌错误**，且没有任何测试会红。
  - **已证实（轻微版）**：`version: 0.1.0` 这类标量确实被读到（HELLO_MANIFEST 断言间接覆盖），但测试没断言它的值；`icon`/`description` 等可选字段的读取路径无测试。
- 最低成本补法：给 `buildManifestSnapshot` 换一个「先让测试红」的样例——喂一份 `requires/capabilities` 与默认值不同的 list 形式 manifest 并断言快照如实读取；随后改用手写最小 YAML 解析（或 js-yaml，仓库已有依赖面需评估）替换正则。测试断言面同时补：`entry` 重写以外，对 `requires/capabilities/version/icon` 全部字段做值断言。

#### H3. hello 页面 `import './sdk/module-sdk.js'` 命中的是 IIFE 产物——部署后浏览器模块加载大概率失败（静态推断，未真机验证）

- 文件:行号：modules/hello/src/index.ts:111（`import { createModuleSDK } from './sdk/module-sdk.js'`）；deploy/cloudflare/src/assemble.ts:125-149（产物：`module-sdk.js` = IIFE 格式 + `globalName: '__unselfSDK'`，**无 ESM 具名导出**；`module-sdk.esm.js` = ESM 版）。
- 脱节描述：页面 import 的是 `module-sdk.js`，而该文件是 IIFE（无 `export` 语句）——浏览器 `import { createModuleSDK } from` 一个 IIFE 会抛 SyntaxError（模块不提供具名导出）。装配注释（assemble.ts:138 附近）自己写了「IIFE 全局名不足以满足具名导入……因此资产侧提供 ESM 版」，但**页面 import 路径却没有跟着指向 `.esm.js`**。
- 对应真实工件：wrapper 资产分支（assemble.ts:300-318，`assetPath = url.pathname.slice(PREFIX.length + 1)` → `ASSETS.fetch('/sdk/module-sdk.js')` → 命中 IIFE 文件）。
- 放过的真机 bug：**潜在（若成立，hello 页真机白屏，正是 #14/#58 同一类「装配产物↔页面契约」踩坑的延续）**。测试面：hello.test.ts:196-201 只断言 HTML 字符串**包含**该 import 路径（把「v4 错误路径」固化为断言）；steps.test.ts 真跑 esbuild（产物是真构建）但**从不检查产物内容**；assemble.test.ts 只测配置文本不测产物——五层测试没有一层回答「页面 import 的路径是否是 ESM 且存在」。
- 标注：本项为静态推断（读代码得出），未在真机/wrangler dev 上复现；也可能 wrangler assets 有未预期的 MIME/模组化行为，验证动作排在第一位。
- 最低成本补法：装配后断言 `assets/<id>/sdk/module-sdk.js` 包含 `export` 语法（或把页面 import 改为 `.esm.js` 并断言对应文件存在）。两类最小动作任选其一即可让风险可见。

#### H4. r2 bucket list：fake 喂 JSON，真实 wrangler v4 输出文本——真机分支零测试

- 文件:行号：deploy/cloudflare/test/steps.test.ts:59-62（fake 的 `r2 bucket list` 返回 `JSON.stringify(buckets)`）；deploy/cloudflare/src/provision.ts:63-76（`ensureR2Bucket` 先解析 `^name:\s+(\S+)$` 文本行，再兜底 JSON）。
- 脱节描述：注释与代码都写着「wrangler v4 的 bucket list 无 --json：成功输出形如 `name:  <桶名>`」——**真机走文本正则分支**；而 fake 只生产 JSON → 测试覆盖的是「虚设分支」，**真实分支的文本解析从未被执行过**。
- 对应真实工件：wrangler 4.x `r2 bucket list` 真实 stdout（文本格式）。
- 放过的真机 bug：**潜在**——真实输出格式一旦与正则不符（缩进/前缀/复数表头变化），每次部署都判「桶不存在」→ 重复 `r2 bucket create` → 真机报 already exists（或竞态）；`ensureR2Bucket` 也没有像 `ensureDatabases` 那样的「创建失败回查」自愈。
- 最低成本补法：fake 改成返回真实文本格式（`name:  unself-storage\n`），同时保留一条文本格式→解析的直测（喂真实样例串给 `ensureR2Bucket` 内部解析函数）。

### 🟠 中

#### M1. 假 Wrangler 对 `d1 migrations apply` / `d1 execute` 全盘接受——SQL 与配置契约零校验（已证实：五连真机踩坑中四个靠真实部署暴露）

- 文件:行号：deploy/cloudflare/test/steps.test.ts:10-86（`makeFakeWrangler`），尤其 :37-40（`migrations apply / execute：接受一切` → `okOut('')`）。
- 记录了什么 / 丢了什么：
  - **记录**：完整命令数组（`state.commands`）、D1 名集合、R2 桶集合、secret 集合、secret put 次数。
  - **丢了**：`d1 execute` 的 SQL 是否合法（`inlineParams` 的 `?1` 替换、单引号转义、SQL 方言全部无校验）；迁移目录是否存在/迁移文件是否有内容；wrangler 对生成 jsonc 的 schema 校验错误（`compatibility_date`、`run_worker_first`、`custom_domain` 形态、`main`/`assets.directory` 相对路径）；`d1 list --json` 真实输出格式（fake 返回 `[{name,uuid}]`，真机 v4 输出形态未核对）；deploy 输出的 `parseWorkersDevFromDeployOutput`（steps 测试一律注入 `resolveBaseUrl` 绕过，真实解析函数零测试）；`putSecretStdin` 真实 spawn 与 `UNSELF_SKIP_SECRET_PUT` 分支。
- 放过的真机 bug（**已证实清单**，来自只读 git log/diff）：
  - 91bd02c「对齐 wrangler 4.x CLI 实际契约（#15 真实部署暴露）」——assemble.test.ts **被迫改 24 行**；
  - e8b1660「domain 绑定改 custom_domains（v4 OAuth 下 zone 路由 10405）」——assemble.test.ts **被迫改 6 行**；
  - 66e8f21「Custom Domain 配置形态改 routes + custom_domain:true」——assemble.test.ts **被迫改 6 行**；
  - df9693e「run_worker_first 用 /setup*」——**只改 src，测试一字未动**（`/setup*` 至今无任何测试断言）；
  - 57a2d73「模块 wrapper 资产分支」——**只改 src，测试一字未动**（wrapper 的子串断言不覆盖资产分支逻辑）。
  结论：这些测试断言的是「生成器输出 == 源码里写死的期望」，不是「生成器输出 == wrangler 真契约」；真机契约靠部署试错，测试事后追认。
- 最低成本补法：① 生成物 JSON.parse 后逐字段语义断言（`/setup*`、`run_worker_first: true`、`main: '<id>/worker.js'`、`assets.directory: '<id>/assets'`、`compatibility_date`）；② 对生成 jsonc 跑一次 `wrangler deploy --dry-run` 之类的本地校验（CI 里 wrangler 已装）；③ `d1 execute` 的 SQL 至少过一遍 SQLite parser（`node:sqlite` PREPARE 即可）。

#### M2. 壳侧 x-request-id 契约全线空转（已证实）

- 文件:行号：apps/shell/src/lib/registry-api.ts:39、setup-api.ts:29、token-api.ts:38（读响应头 `x-request-id` → `requestId` → UI 异常卡 `:request-id="...requestId"`，App.vue:245/283、SetupView.vue:185）。
- 脱节描述：**core-api 全源码 grep 无任何 `x-request-id` 输出**（services/core-api/src 下 0 命中）→ 生产环境该头恒不存在 → `requestId` 恒 `undefined` → §6.5「三层透传 request id + 技术详情折叠」里的 request id 展示功能是死的。测试侧（setup-api.test.ts:31-35 的 `jsonResponse`）把 `headers.get` mock 成恒返回 null——既测不出「core-api 根本没这头」，也无法在 core-api 补头后做契约对齐。
- 对应真实工件：core-api 的错误响应体（`{ error, detail }` 形状——detail 部分壳侧有消费，但 core-api 实际错误响应从不带 detail，同样是死契约）。
- 放过的真机 bug：**已证实（功能级）**——部署后用户看到的异常卡 request-id 恒空，排查依据缺失；更糟的是测试通过造成「该功能已实现」的错觉。
- 最低成本补法：契约测试一条即可——用真实 core-api（Hono app）错误响应 + 壳侧 client 断言 `requestId` 链路；并在 core-api 加公共中间件输出 `x-request-id`。

#### M3. module-sdk `verifyModuleToken` 真实验签链路零测试

- 文件:行号：packages/module-sdk/test/sdk.test.ts:266-278（唯一用例：垃圾 token「在 fetch 前就失败」）；真实工件：packages/module-sdk/src/verify.ts（`createRemoteJWKSet` + `jwtVerify`，kid 选钥、JWKS HTTP 拉取、404/5xx 失败、audience 校验、claims schema 解析）。
- 脱节描述：`verifyModuleToken` 的**一切正常路径与失败路径都没有测试**（无 mock fetch 喂 JWKS）。core-api 侧 token.test.ts:117-125 和 keys.test.ts:70-75 用「单钥 importJWK 直验」近似——注释甚至自称「模块后端验签的真实路径」，但真实路径是 RemoteJWKSet（按 kid 从 HTTP 集选钥），**全仓没有一处测过 RemoteJWKSet 路径**；hello 模块 `requireAuth`（modules/hello/src/index.ts）用的正是该路径。
- 放过的真机 bug：**潜在**——module-sdk 消费者传错 `jwksUrl`/`audience`、JWKS 端点 404 时的错误语义、kid 不匹配时的重取行为，全部无测试把门；hello.test.ts 用「mock fetch 服务 JWKS 端点」绕过了 `verifyModuleToken` 函数本身（直接 `jwtVerify + createRemoteJWKSet`，与 SDK 一致但**没用量产函数**）。
- 最低成本补法：在 sdk.test.ts 给 `verifyModuleToken` 加 mock-fetch JWKS 端点（模式可复用 core-api oidc.test.ts 的 `installFakeIdp`），用真 ES256 签发 token 走完整 happy path + audience 错 + 过期 三条。

#### M4. storage.test.ts 假 D1 的「边界代偿」——fake 替被测代码背锅

- 文件:行号：packages/module-sdk/test/storage.test.ts:29-101（`MemoryStatement.select` 恒取 `params[0]` 作 moduleId 过滤）。
- 脱节描述：SDK 的 SQL 若**漏写 `WHERE module_id = ?`**（例如 list 只留 `key LIKE ?`），fake 仍会用 `params[0]`（恰为 moduleId）过滤——**测试绿，真机上跨模块键泄漏**。同理：fake 的 LIKE 是正则重写（大小写敏感、无 collation），与 SQLite 真实 LIKE（默认 ASCII 大小写不敏感）语义有偏差；`first()` 用 `params[1]` 作 key——若真实 SQL 参数顺序变化，fake 会错配参数而测试仍绿（或假红）。
- 对应真实工件：modules/hello/migrations/hello/0001_module_kv.sql（`PK(module_id, key)`——`ON CONFLICT(module_id, key) DO UPDATE` 依赖该 PK；fake 的 Map 天然无 PK 概念，PK 被删时测试无感）。
- 放过的真机 bug：**潜在（数据隔离类，未来高危）**——module_kv 是全模块共享表，跨模块泄漏 = 数据越权；当前源码 SQL 正确，属「未爆雷的定时炸弹」。
- 最低成本补法：同 H1——用真 SQL 引擎（node:sqlite）+ 真迁移建表跑 storage.test；至少把「断言 SQL 文本含 `module_id = ?`」加入（字符串级断言虽糙，能拦住边界代偿）。

### 🟡 低

#### L1. module-bridge（壳↔模块握手全程）零测试

- 文件:行号：apps/shell/src/lib/module-bridge.test.ts（只测 `frameOriginFor` 纯函数）；被测对象 attachModuleBridge（module-bridge.ts:20-62）：`event.origin`/`event.source` 校验、`SdkMessageSchema` 解析、`fetchModuleToken` 调用、`postMessage(..., options.frameOrigin)` 下发、detach 清理。
- 脱节描述：壳侧桥的**安全关键路径无测试**；SDK 侧（sdk.test.ts 假 window）测得很细，但两端消息形状（壳发 `{type:'token', token}` vs SDK 收 `{type:'token', token}`）靠人肉对齐——无一条跨端集成用例。若任一侧改形状（例如补 `expiresIn`），另一侧无感知。
- 放过的真机 bug：**潜在**——同源 iframe 下 `event.origin` 即实例 origin，若未来改第三方模块（绝对 URL 逃生口），`frameOrigin` 与模块内 SDK 配置的 `coreOrigin` 不一致时握手静默失败，测试无感。
- 最低成本补法：一条「假 iframe + 假 window」双端测试：壳 attachModuleBridge + 模块侧 createModuleSDK 同进程握手，断言 token 流转（可复用 sdk.test.ts 的 `installFakeWindow` 思路）。

#### L2. registry-api.test.ts 不测 `fetchEnabledModules`——/api/modules 响应形状无壳侧测试

- 文件:行号：apps/shell/src/lib/registry-api.test.ts（4 个用例全是 `moduleFrameSrc`）；被测：registry-api.ts:32-53 `fetchEnabledModules`。对应真实工件：core-api `listModules` → `rowToEntry`（registry.ts:29-47），条目含 `registeredAt`（新字段）与 `manifest: null`（JSON 解析失败分支）。
- 脱节描述：壳侧 `RegistryModule` 接口（registry-api.ts:6-22）没有 `registeredAt` 字段（多余字段无碍，但契约无声明）；`manifest: null` 分支（rowToEntry 对坏 JSON 返回 null）在壳侧无测试（`moduleFrameSrc` 的 `manifest: null` 用例只是 URL 函数级）。
- 放过的真机 bug：**潜在**——core-api 响应契约变更（字段重命名/移除 manifest.entry）无任何壳侧测试拦截。
- 最低成本补法：加 `fetchEnabledModules` 的 fetch mock 用例（URL `/api/modules`、credentials、错误映射、真实条目形状断言）。

#### L3. 假发现文档（setup.test.ts:246-268 `installFakeDiscovery`）只实现 discovery——`/api/auth/login` 的完整链路（含流程 Cookie 校验）由 auth-routes.test.ts 覆盖，二者独立；无脱节，但 setup.test 的 login 断言（:218-224）只断言 302 + location 前缀，未校验 Cookie 属性（auth-routes.test.ts:117-119 有）。轻微。

#### L4. `sanitizeNext` 开放重定向边缘空白（静态推断，低置信）

- 文件:行号：services/core-api/src/index.ts:262-267（core 侧 `sanitizeNext`，callback 用）与 apps/shell/src/lib/landing.ts（壳侧同款）。
- 描述：只挡 `//` 与不以 `/` 开头的值；`////evil.example`、`/\evil.example` 等形态在浏览器（special scheme 把 `\` 当 `/`、多斜杠进入 authority 解析）下可能解析为协议相对 URL——**两个实现都无对应测试**（两个 sanitizeNext 也都无测试——core 侧的完全没有，shell 侧只测了 `//evil.example`）。
- 放过的真机 bug：**潜在（安全类）**——callback 的 `next` 参数经 open-redirect 把会话带往外部站（风险随 OIDC 部署真实化）。低置信：浏览器 URL 解析行为未在报告中核实。
- 最低成本补法：两端各补 `////`、`/\`、`http:` 变体用例（期望拒绝），用 `new URL(next, base).origin !== base.origin` 的判定替换现有前缀判定（补法为建议，未验证）。

#### L5. 生命周期 export 与真实数据的出入（源码层面问题，测试帮倒忙）

- 文件:行号：modules/hello/src/index.ts:300-319（`/life/export` 的 `tables.hello_counter.rows` 由 `readCount`——读的是 `module_kv`——编造），测试 hello.test.ts:175-181 把这个编造形状当契约断言。
- 脱节描述：hello 真迁移同时有 `hello_counter`（0001_init.sql）与 `module_kv`（0001_module_kv.sql）；实际计数只写 `module_kv`，`hello_counter` 从未被写；export 却宣称导出 `hello_counter`。测试 fake 里**根本没有 hello_counter 表**，断言的是源码编造的形状——「schema 版本化导出」语义已漂移，测试在固化漂移。
- 放过的真机 bug：**潜在（M1 卸载剧本的直接数据源）**——purge 清的是 module_kv（:326-331），export 声称的 hello_counter 与 purge 实际对象不一致；真机导出/恢复会丢数据或恢复错表。
- 最低成本补法：export 前用真迁移核对表集（或先改源码使其自洽），测试用「真 SQL 引擎 + 真迁移」跑 hello.test。

---

## 二、已核实「无脱节 / 质量好」的部分（避免误伤）

- **oydic.test.ts / auth-routes.test.ts 的假身份源**：真 RS256 密钥对（jose 生成）、真 `jwtVerify`（mock fetch 只到网络边界，JWKS 经 createRemoteJWKSet 真拉取）、`state/nonce/iss/aud/exp` 校验全部真跑；fail-closed（缺 jwks_uri、JWKS 500、坏签名、nonce/aud/iss 错、过期）各有用例。**未绕过验签**，是全仓测试范本。
- **session.test.ts / keys.test.ts**：真实 WebCrypto/jose，无脱节。
- **oidc.test.ts 的 PKCE**：`code_challenge` 按 RFC 7636 独立重算比对；但**假 token endpoint 不校验 code_verifier**（假 IdP 不验 PKCE 属固有边界，标注为「无法用假 IdP 测试」——真机侧依赖 IdP 行为）。
- **hello.test.ts 的服务端路径**：模块 token 用真 ES256 签名 + mock fetch 服务 JWKS 端点 + 真 jose 验签（:87-112），aud 越权用例真实有效。
- **迁移文件本身与源码查询列已对齐**：core 0001/0002/0003 列集合与当前 `registry.ts`/`setup.ts`/`token.ts`/`index.ts` 中所有 SQL 逐条比对一致（这是 #56 修复后的状态）。

---

## 三、附录：空洞 / 脆弱断言清单

1. **packages/ui/test/ui.test.ts（全文件）**：导出存在性 + `UI_VERSION === '0.1.0'`——版本号断言恒真，组件零行为测试（M0 可能有意为之，但属于「测了等于没测」）。
2. **modules/hello/test/hello.test.ts:165-170「身份行数据源」**：断言 `makeToken`（**测试自己的 fixture**）带 name/email，decodeJwtPayload 后能读到——自证循环，验的是 fixture 不是产品。
3. **services/core-api/test/token.test.ts:106-122「已停用模块在启停后可再取 token」**：两个独立 `makeDb()` 新实例（disabled 与 enabled 各建一个），**不是同一 DB 状态的翻转**——用例名与行为不符，翻转语义实际由 registry.test.ts 覆盖（命名误导 + 重复造轮子）。
4. **deploy/cloudflare/test/assemble.test.ts:27**：`expect(assets.run_worker_first).toContain('/api/*')`——数组子串断言，`/setup*` 与完整集合永远测不到。
5. **deploy/cloudflare/test/assemble.test.ts:81-93（prefixStripWrapperSource）**：3 条 `toContain` 子串——`isAsset` 分支、index.html 预取、`duplex: 'half'`、`assetPath` 切片全无断言（#58 修复对象就在这段代码里）。
6. **modules/hello/test/hello.test.ts:170-181（页面断言）**：`toContain` 子串 + `toMatch` 正则固化实现细节（`id="who"`、`+1`、`createModuleSDK`）——脆弱但历史上有用（#14 真 bug 防回归），归类「脆弱但有意」。
7. **services/core-api/test/registry.test.ts:88**：`expect(db._registry.get('hello')?.manifest_json).toContain('"counter"')`——子串断言 manifest 快照；**:116-118** 审计断言 `toContain('module_disabled')`——子串。
8. **deploy/cloudflare/test/steps.test.ts:139-157（顺序断言）**：`idxOf(RegExp)` 相对位置 + `filter(c => c.includes('UPDATE module_registry')).toHaveLength(0)`——只查 UPDATE，不查 SELECT/INSERT/迁移目录参数等；命令内容的语义校验整体偏弱。
9. **packages/module-sdk/test/sdk.test.ts:118-124（无 window no-op）**：在无 window 环境断言「不抛错」——恒真。
10. **apps/shell/src/lib/setup-api.test.ts 的 `jsonResponse`**：`headers: { get: () => null }`——恒 null 的 x-request-id 桩（见 M2）。
11. **services/core-api/test/oidc.test.ts:99-109「issuer 不匹配时拒绝」**：`discover('https://evil.example.com')` 喂的假文档 issuer 是另一个域——测试的是 discover 的缓存键（issuer 匹配）而非隔离，断言有效但用例命名文不对题，轻微。

---

## 四、优先修复建议（按投入产出）

| 优先级 | 动作 | 覆盖脱节点 |
|---|---|---|
| 1 | 统一「真迁移建表 + node:sqlite 真执行」test-utils，替换 core-api 4 处假 D1 | H1（#56 同款再犯的主要兜底） |
| 2 | 装配后校验 SDK 资产 ESM 导出 + 页面 import 路径命中 ESM 产物 | H3（静态推断的真机炸点） |
| 3 | `buildManifestSnapshot` 测试喂非默认值 list 形式 manifest | H2（token caps 授牌错误） |
| 4 | assemble 断言补全（/setup*、main、assets.directory、schema 校验）；r2 bucket list fake 改真实文本格式 | M1、H4 |
| 5 | core-api 补 x-request-id 中间件 + 壳侧契约测试 | M2 |
| 6 | verifyModuleToken 补 mock-fetch JWKS happy/fail 路径 | M3 |

（报告完）
