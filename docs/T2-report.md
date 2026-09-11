# T2 报告 · M0 计划偏离审核（子任务①）

- 审核对象：`origin/m0/dev` @ **57a2d73**（fix(deploy): 模块 wrapper 资产分支——相对引用剥前缀 + 空路径落 Hono）
- 审核方式：`git archive origin/m0/dev` → `/tmp/audit/wt-1`（零写入仓库），全部证据取自该副本
- 真源：`docs/PRODUCT_SPEC.md`（§5.1 L205+、§5.2、§5.3、§5.5、§6.5、§7、§8）+ `docs/requirements.md` §6 决策 #1–#22
- 范围：`deploy/cloudflare/`、`apps/shell/`、`services/core-api/`、`packages/`、`modules/hello/`、仓库根文档与配置
- 事前声明：审核时执行过一次 `git fetch origin`（仅更新远端跟踪引用，未 checkout、未改工作区；若需严格零写可复核 `origin/m0/dev` 内容与 57a2d73 一致——已比对，一致）

---

# A. §5.3 单域名路径制偏离专项

## A0. 总览

计划：第一方模块一律同域路径挂载——Cloudflare `Workers Routes` 按路径绑定（`team.example.com/m/<id>/*` → 模块 Worker），Docker openresty location 等价（§5.3、§7、决策 #13）。

实现：`moduleWranglerConfig` 生成的模块路由是 **`<id>.<domain>` custom_domain 子域**（assemble.ts:244），core 主域也走 `custom_domain:true`（assemble.ts:193）。真机形态「unself.demo.handywote.top（主域）+ hello.unself.demo.handywote.top（模块子域）」即由此而来。

偏离根因链（git 历史可证）：`e8b1660`（v4 OAuth 下 zone 路由 10405 → 改 custom_domains）→ `66e8f21`（custom_domains 配置形态改 routes+custom_domain:true）→ `e5df996`（wrapper .fetch + **冒烟子域路由**）→ `df9693e`（core SPA 兜底）→ `57a2d73`（wrapper 相对引用剥前缀 + 空路径落 Hono）。每一条后续补丁都在「修」子域制自己的症状，而非回滚偏离本身。

最尖锐的事实：**部署文档写的是路径制，部署代码写的是子域制**——
- `deploy/cloudflare/README.md` ④「`route = <domain>/m/<id>/*`」；`README.md` L20「/m/<模块id>/* → 各模块 Worker」。两份 README 均与 §5.3 一致。
- `deploy/cloudflare/src/assemble.ts:244`「`<id>.${config.domain}` 子域 custom_domain」与 README 矛盾，**至今无人发现**。

下文逐文件给出证据与分类。（a）= 计划允许的机制等价替换；（b）= 结果级偏离，需修订设计；（c）= 违反计划至今无人发现。

## A1. deploy/cloudflare/src/assemble.ts

### A1.1 模块路由 = 子域 custom_domain —— (b) 核心偏离载体
```
244:        ? { routes: [{ pattern: `${mod.id}.${config.domain}`, custom_domain: true }] }
```
生成 `hello.unself.demo.handywote.top` 全 host 绑定，与 §5.3「按路径绑定（`/m/<id>/*`）」冲突。模块 Worker 收到的是子域根路径请求（`https://hello.<host>/...`，pathname 无 `/m/hello` 前缀），整个 wrapper 的设计前提（见 A1.3）被掏空。

### A1.2 core 主域路由与 10405 注释 —— (a)+(c)
```
191:      // Custom Domain 的配置形态是 routes + custom_domain:true（自动建 DNS/证书）；
192:      // zone 路由（无 custom_domain 标记）对 OAuth 认证 10405
193:      ...(route ? { routes: [{ pattern: route, custom_domain: true }] } : {}),
```
- 主域绑到 core Worker：与路径制不冲突（主域始终要绑 core），形态上可以保留 `custom_domain:true` → 归 (a)。
- 但 L191-192 注释把「custom_domain 化」写成对 10405 的**修复**，且只字未提「此修复只对 core 成立、模块路由本应走 zone 路径」——面向未来维护者的注释在固化偏离 → 归 (c)。10405 的根因是 OAuth 凭证权限不足，正解是部署凭证补 API Token（用户已拍板），不是改路由形态。

### A1.3 prefixStripWrapperSource —— 缝合怪本体（#56/#58 机制源）
```
298:// 由 deploy/cloudflare 生成：剥 /m/${moduleId} 前缀 + ASSETS 回退 + 绝对 URL 头重写。
301:const PREFIX = '/m/${moduleId}';
306:    const isAsset = !url.pathname.startsWith(PREFIX + '/api/') &&
307:                    !url.pathname.startsWith(PREFIX + '/life/') &&
309:    if (isAsset && url.pathname.length > PREFIX.length + 1) {
314:      const assetPath = url.pathname.slice(PREFIX.length + 1);
315:      return env.ASSETS.fetch(new URL('/' + assetPath, url.origin));
318:    url.pathname = url.pathname.slice(PREFIX.length) || '/';
```
问题链（子域制下实测推演）：
1. **剥的是不存在的路径前缀**。子域绑定下模块 Worker 收到的自然请求 pathname 是 `/api/count`、`/sdk/module-sdk.js`（无 `/m/hello`）。`'/api/health'.slice(7) → 'alth'`（L318），Hono 路由恒不匹配 → `#58`（模块页/接口失效）。
2. **isAsset 恒真 + 切片错位**。`GET /api/count` 不以 `/m/hello/api/` 开头（L306 判否）且方法为 GET → 视为资产；`'/api/count'.slice(8) → 'unt'`（L314）→ `ASSETS.fetch('/unt')` → 404 直接返回，**Worker 永不可达** → `#56`（模块 API 404）。任意 GET 皆命中此分支，包括根路径外的所有请求。
3. 全代码只有一种 URL 形态能通过 L306 判定并正确剥前缀：**`https://hello.<host>/m/hello/...`** —— 即「子域制实现，却在 URL 上保留路径制形态」。这是缝合怪的核心：`smoke.ts` 恰好用这一幽灵形态（见 A3），所以冒烟绿、真机红。
4. L298 注释「绝对 URL 头重写」无对应代码（模板无任何 header 重写语句）——注释先于/脱离实现。
5. `57a2d73` 本身是子域制症状的补丁（「空路径落 Hono」只救 GET 根路径 `/`，不救 API/资产）。
6. 分类：根因属 (b)（由 A1.1 导出）；但「wrapper 按路径制编写、却要在子域制下工作」这一自相矛盾**从 e8b1660 起就存在**，无人在 PR 中质疑 → 同时记 (c)。

### A1.4 附带发现：UNSELF_BASE_URL 死配置 —— (c)（轻微）
```
215:        ...(config.domain ? { UNSELF_BASE_URL: `https://${config.domain}` } : {}),
```
全仓仅此处设置、无任何消费者（grep 确认）。config 里 `domain` 外的第二个主机相关变量，无人使用无人删。

## A2. registry.ts buildManifestSnapshot —— manifest 声称与真实拓扑脱节（#57 根因）

```
32:/** manifest.yaml 文本 → ModuleManifest（§5.5 快照 + §5.3 entry 重写为实例 URL）。 */
43:    route: fields.route ?? `/m/${input.moduleId}`,
44:    // 部署后模块实际从实例根相对路径装载（同域路径制 §5.3）
45:    entry: `${host}/m/${input.moduleId}/`,
```
- L45 生成 **路径制 entry**（`https://unself.demo.handywote.top/m/hello/`），而部署实际在**子域**（`hello.unself.demo.handywote.top`）。manifest 声称的装载点与真实拓扑脱节：壳按 entry 导航（A5）→ 打到主域 → core Worker → SPA 兜底 → **iframe 装成壳 HTML**（issue #57）。
- L44 注释声称「部署后模块实际从实例根相对路径装载（同域路径制 §5.3）」——与实现（子域制）**相反**，注释掩盖偏离 → (c)。
- 归因：buildManifestSnapshot 是「路径制正确实现 + 子域制错误部署」的组合；B 方案下无需改代码，注释自动成真。→ (b)（结果）,(c)（注释掩盖）。

## A3. smoke.ts —— 冒烟目标形态与产品拓扑脱节（(b)+(c)）

```
43:/** 冒烟：core health + 各模块 health。custom domain 模式下模块在 <id>.<域名>（子域式）；workers.dev 模式走主域路径路由 §5.3。全部 200 且 ok=true 才算通过。 */
48:  /** custom domain 模式：模块 host = <id>.<baseUrl host> */
49:  moduleSubdomain?: boolean;
56:      path: `/m/${id}/api/health`,
57:      base: input.moduleSubdomain ? `https://${id}.${host}` : input.baseUrl,
```
- L43/L48/L49：把「子域式」写进代码注释当作设计事实 → (c)。
- L56+L57 组合：`https://hello.<host>/m/hello/api/health` —— **子域 host + 路径制 path 的混合幽灵 URL**。真实用户可到达的形态只有：主域 `/m/hello/…`（归 core SPA，A2）或子域根 `/…`（wrapper 畸形切片，A1.3）。冒烟测的形态**不属于任何真实访问路径**——正是靠它绕过 L306 判定才通过。
- 结论：**目前冒烟全绿完全不能证明端到端链路通**。#56/#57/#58 三 bug 就发生在这条「测不到的路径」上 → (c) 级别的事故盲区，同时该分支本身是子域制的衍生物 → (b)。

## A4. steps.ts / main.ts —— 日志与实现不符（(c)）

```
180:  rep.step(4, '构建上传模块 Worker，绑 /m/<id>/* 路由与存储绑定');
198:    rep.log(`模块 ${mod.id} 已部署（路由 /m/${mod.id}/*）`);
243:        // custom domain 模式模块在 <id>.<域名>（与 custom_domains 绑定一致）
244:        moduleSubdomain: Boolean(config.domain),
```
- L180/L198 日志声称绑 `/m/<id>/*`，L244 实现绑子域——部署日志对运维/验收者撒谎 → (c)。
- L243-244：`Boolean(config.domain)` 把「配置了域名」直接等价为「子域制」。**回 B 方案时此旗标必须删除**，否则 B 下冒烟仍会打子域 URL → 404 → 部署必败。
- main.ts L42 摘要「模块 hello：/m/hello/*（配置 …）」同属误报 → (c)。

## A5. 壳侧证据链 —— 壳按路径制正确消费，撞上错位供给

壳侧（apps/shell）本身是 §5.3 的**正确实现**，问题全在供给端：
- `registry-api.ts:60-67` `moduleFrameSrc`：同域 entry → 相对路径（`url.pathname + url.search`）→ iframe src = `/m/hello/`。§5.3「同域路径装载」的忠实消费。
- `App.vue:291-294` `:src="frameSrc"`：get `/m/hello/` → 主域 default route（custom_domain 全收）→ core-api Hono 无 `/m/*` 路由 → 404 → `steps.ts:336-343` coreWorkerEntrySource 仅对 `/api/*`、`/life/*`、`/.well-known/*`、非 GET 拒绝回退 → **GET `/m/hello/` 落 ASSETS SPA → shell index.html 进 iframe** → SDK `ready` 永不出现 → 15s 握手超时（App.vue:129-137）→「模块加载超时」异常卡。**#57 的完整机制**。
- `App.vue:171-172` `moduleHref` → `/m/${id}/`（新窗口打开）：同受 #57 影响 → (b) 连带。
- `module-bridge.ts:59-67` `frameOriginFor`：entry 同域 → origin=主域。壳侧对同域/跨域两种形态均兼容；B 方案下（entry=主域路径）origin 判定天然正确 → 零改动。
- `nav.ts:17`、`landing.ts:31/35/37`、`landing.test.ts:8/23/27/37`：全部按路径制生成/解析 `/m/<id>/` → 与 §5.3 一致 ✓（B 下全对）。

结论：**壳侧无子域制痕迹，无需改动**；「主域 /m/hello/ 会被壳 SPA 200 兜底接走」的机制证据 = registry.ts:45 + steps.ts:339-343 + registry-api.ts:67 + App.vue:291-294 四段拼接。

## A6. modules/hello/manifest.yaml —— entry 占位

```
4:entry: http://localhost:8790/ # 占位：M0 后由 core-api 注册的运行时地址
```
- 按 §5.1 `entry` 是完整 URL；占位值仅用于开发期直跑（不经过 registry 快照重写时）。部署路径下 `buildManifestSnapshot` 无条件重写为实例 URL（registry.ts:45），所以占位本身不构成产物偏差 → 不适用（开发期合法）。
- 但与 A2 组合成三层错位：**占位 localhost → 快照路径制 URL → 部署子域实址**。B 方案下占位→快照→实址三者一致（快照 = 主域路径 = zone 路由实址）。

## A7. services/core-api 与 packages/ —— 无 DNS 子域假设（符合）

- `services/core-api/`：全部路由/令牌/注册表/setup 逻辑与域名无关；唯一主机相关逻辑是 `index.ts requestOrigin()`（拼 OIDC redirect_uri）与 `assemble.ts:215 UNSELF_BASE_URL`（死变量）——均无子域假设 → **符合**。
- `packages/`：无 DNS 域名代码。唯一的「子域」字样在 `module-sdk/src/storage.ts:4/46/58`、`modules/hello/src/index.ts:23/47/53`，语境是**数据命名空间**（module_id 收口）：「模块在自己的子域（moduleId）内读写键值数据」。语义正确（指数据作用域），但与 DNS 子域概念撞名，且 storage.ts 注释把该「子域」作为 SDK 边界术语反复使用——建议改称「模块作用域」，避免下一人误读为 DNS → (c) 术语级（轻微）。

## A8. 测试断言中的子域/路径假设

| 位置 | 断言 | 判定 |
|---|---|---|
| deploy/cloudflare/test/assemble.test.ts:28 | core `routes = [{pattern:'team.example.com', custom_domain:true}]` | 与路径制兼容（主域绑 core 可保留）→ B 下**可不改**；但注释语境属偏离产物 |
| assemble.test.ts:61 | 模块 `routes = [{pattern:'hello.team.example.com', custom_domain:true}]` | **(c) 把偏离固化为预期行为**；B 回滚必改为 `{pattern:'team.example.com/m/hello/*'}` |
| assemble.test.ts:68-73（prefixStripWrapperSource） | 仅断言「源码包含」剥前缀语句 | **(c) 盲区**：wrapper 的畸形切片行为（A1.3）零行为测试 |
| steps.test.ts:64-65/97-99 | fake wrangler 返回 `*.test-subdomain.workers.dev`；SMOKE_OK 用路径制 URL（74-84 行） | 测试注入绕开了真实 `smokeCheck` → **moduleSubdomain 分支零覆盖** → (c) 盲区 |
| provision-registry.test.ts:47-49 | `buildManifestSnapshot` entry = `https://team.example.com/m/hello/` | 断言与 §5.3 一致（B 目标）；但与部署实现（子域）矛盾且测试注释未察觉 → (c) 矛盾固化 |
| apps/shell/registry-api.test.ts:23-30 | 同域 entry→相对路径；独立域名 entry→绝对（§5.3 逃生口） | 符合 ✓ 零改动 |
| modules/hello/test/hello.test.ts:179-190 | 断言页面用相对路径 fetch/import（「部署挂载在 /m/<id>/ 子路径，#14 装配前提」） | 与 §5.3 一致，**是子域制下页面失效（#58）的反向证据**：相对路径在子域根解析为无前缀 URL，正好落入 A1.3 畸形切片 |

## A9. 注释级偏离汇总

| 位置 | 偏离表述 | 类别 |
|---|---|---|
| assemble.ts:5 | 摘要只写「route」不写形态（中性） | 无（列出备查） |
| assemble.ts:191-192 | 10405 → custom_domain 叙述为修复 | (c) |
| assemble.ts:244 上下文 | 子域 pattern 无任何「偏离/临时」标记 | (c) |
| assemble.ts:298 | 声称「绝对 URL 头重写」——实现无此逻辑 | (c)（轻微，注释不实） |
| smoke.ts:43/48 | 「custom domain 模式下模块在 <id>.<域名>（子域式）」当作既定事实 | (c) |
| steps.ts:243 | 「与 custom_domains 绑定一致」——把偏离当常识 | (c) |
| storage.ts:4/46/58、hello/src/index.ts:23/47/53 | 「子域」= 数据作用域，与 DNS 子域撞名 | (c)（术语） |
| registry.ts:44 | 「部署后…同域路径制 §5.3」——与实现相反 | (c)（严重：注释撒谎） |
| deploy/cloudflare/README.md ④、README.md:20 | 路径制「/m/<id>/*」——文档正确、实现相反 | (c)（最强证据） |

## A10. #56/#57/#58 机制链（汇总）

| Issue | 机制 | 证据链 |
|---|---|---|
| #57 iframe 装成壳 HTML | 快照 entry=主域路径 → iframe 主域 /m/hello/ → core 兜底 SPA | registry.ts:45 → registry-api.ts:67 → steps.ts:339-343 → App.vue:291-294 |
| #56 模块 API 404 | 子域根 GET → isAsset 恒真 → slice 错位 → ASSETS 404 | assemble.ts:306-315 |
| #58 模块页 JS/接口失效 | 页面渲染 OK（57a2d73），但相对引用解析为无前缀 URL → 同 #56 切片 | hello/src/index.ts:119-120 + assemble.ts:306-318 |

三者同源：**在子域制实现上运行路径制代码**。wrapper、smoke 子域分支、57a2d73 全是这个错配的衍生物。

## A11. 回 B 方案改动面（逐文件）

| 文件 | 改什么 | 量级 |
|---|---|---|
| deploy/cloudflare/src/assemble.ts | 1) `moduleWranglerConfig` L244：`routes` 改 zone 路径 `{ pattern: \`${config.domain}/m/${mod.id}/*\` }`（去 `custom_domain:true`；**需补 zone 标识**，见下「凭证议题」）；2) L191-193：core 主域路由保留 custom_domain（可不动）或改 zone root（备选，建议保留现状）；3) L191-192 注释改写（10405 → 「部署须 API Token，OAuth 10405 由凭证方式解决」）；4) L298 删「绝对 URL 头重写」；5) wrapper 主体**零改动**（B 下前缀真实存在，语义恢复；57a2d73 空路径分支变为冗余但无害） | **M** |
| deploy/cloudflare/src/steps.ts | 1) L243-244 删 `moduleSubdomain: Boolean(config.domain)`（smoke 调用还原为不传 flag）；2) 步骤④日志保持（B 下成真） | **S** |
| deploy/cloudflare/src/smoke.ts | 1) 删 `moduleSubdomain` 参数与两处分支（L43/48-49/57）；2) 注释改回「各模块 health 经实例域路径路由 §5.3」 | **S** |
| deploy/cloudflare/src/config.ts + unself.config.jsonc | zone 路径路由需要显式 `zone_id`/`zone_name`（custom_domain 免此）。候选：config 增 `zone` 字段（多级子域无法从 domain 推断，须显式；真机 zone=handywote.top）。**此项形态待设计确认，标注为不确定**（API Token 模式 wrangler 不自动带 zone 上下文） | **S**（若定案）+ 配置样例注释 |
| deploy/cloudflare/test/assemble.test.ts | L61 断言改 `{ pattern: 'team.example.com/m/hello/*' }`（含 zone_name 视定案）；补充 wrapper 行为测试（剥前缀正确性、非 API GET 走 ASSETS 的成功路径——B 下可写真断言）；L28 保持 | **M** |
| deploy/cloudflare/test/steps.test.ts | SMOKE_OK 已路径制无需改；建议新增 `smokeCheck` 路径制单测（现零覆盖） | **S** |
| deploy/cloudflare/test/provision-registry.test.ts | entry 断言已路径制（不动）；可选：修正测试注释（「快照与部署一致」） | **S**（可不动） |
| deploy/cloudflare/README.md | ④ 表已写对（不动）；补「凭证：`CLOUDFLARE_API_TOKEN`（Zone.Workers Routes/D1/R2/Workers Scripts 权限）替代 `wrangler login`，10405 背景」 | **S** |
| apps/shell/、modules/hello/、services/core-api/、packages/ | **零改动**（全部已按路径制实现/无域名假设） | — |
| modules/hello/manifest.yaml | 可选：占位 entry 改注释说明（快照会重写），非必须 | S（可选） |
| 真机重验（非代码） | 用 API Token 重新部署 unself.demo.handywote.top；验证 #56/#57/#58 三链闭合；冒烟 URL 变为主域路径 | **L**（工作项） |

「凭证议题」要点（依据 assemble.ts:191-192 与 README「前置：wrangler login（或环境变量 CLOUDFLARE_API_TOKEN）」）：API Token 路径已存在（wrangler.ts:35 不写死认证方式），10405 属 OAuth token 缺 zone 路由权限；B 方案只需**部署时改用 API Token + 文档化权限清单**，代码层 wrangler.ts 无需改动。

---

# B. 其余契约逐条对照

## B-1 §5.1 模块契约

| 条款 | 判定 | 证据 |
|---|---|---|
| manifest 必备字段（id/route/entry/runtime/requires/capabilities/version/icon） | 符合 | contracts/src/manifest.ts `ModuleManifestSchema`（id 正则/route 以 `/m/` 开头/`entry: z.url()`/runtime 枚举/requires≥1 仅 identity/icon `[a-z0-9-]+` 可选） |
| 三通道（manifest / module-sdk / Core API） | 符合 | manifest.yaml+registry 快照；packages/module-sdk/src/client.ts（ready/token/navigate/notify/theme 消息）；services/core-api（token/registry/session 端点） |
| iframe 默认装载器，自研同级同规 | 符合 | App.vue:291-294 iframe 装载；hello 同为 iframe 装载 |
| icon：存图标名、壳白名单渲染、缺省回退首字 | 符合 | apps/shell/src/lib/module-icon.ts 白名单+fallback；contracts.test.ts:52 断言 `icon:'📨'` 被 schema 拒绝 |
| iconUrl 暂不设 | 符合 | manifest.ts 无 iconUrl |

## B-2 §5.2 模块身份与 token 交换

| 条款 | 判定 | 证据 |
|---|---|---|
| 核心签发 JWT；一条 JWKS 通用 | 符合 | core-api keys.ts+`.well-known/jwks.json`（index.ts:388-394）；hello 与 sdk 均 remote JWKS |
| aud = 模块 id | 符合 | token.ts:54 `aud: ctx.moduleId`；token.test.ts:125 |
| 有效期 10 分钟 + 静默续期 | 符合 | token.ts:21 `600`；client.ts RENEWAL_LEAD_MS=2min、TTL/3 动态提前量；token.test.ts:124 |
| sub = 核心内部稳定用户 id | 符合 | token.ts:52 `sub: ctx.userId`（session uid）；token.test.ts:126 |
| 交付 = postMessage 握手（不进 URL/Cookie/日志） | 符合 | module-bridge.ts（壳侧 origin+source 双向校验）→ postMessage；SDK waitForToken/startTokenLoop 均校验 `event.origin === coreOrigin` |
| 模块后端只验签（JWKS+aud） | 符合 | hello/src/index.ts createAuthMiddleware/requireAuth；sdk verify.ts |
| 停用踢人广播（lifecycle 钩子） | **不适用（M0 无成员停用功能）**；token 门禁 10 分钟兑底 | checkTokenGate（token.ts:88-105）存在即兑底；无成员停用 API |
| 登出：壳清会话并广播登出消息 | **偏离（弱）**：清 cookie ✓（App.vue:142-144 + /api/auth/logout），但**未广播**——messages.ts 无 `logout` 消息类型，SDK 无丢弃 token 处理。缓解：登出整页跳转直接销毁模块上下文，token 天然失效；契约层仍需补 | (b)，建议 M0 补：契约加 `{type:'logout'}` + App.vue onLogout 广播 + SDK `stopTokenLoop` |
| 一次性 setup token、用后封死 | 符合 | setup.ts consumeSetupToken+markSetupDone；核心 409 语义；部署输出打印（main.ts）；前端 setup-guard 重定向 |
| 首个管理员由 setup 产生 | 符合 | activate（index.ts:299-309）promoteToAdmin 后 markSetupDone |
| 登出/外部 SLO | 不适用（SLO 明确标注远期） | — |
| 会话 Cookie 安全属性 | 符合（补充） | session.ts HttpOnly/SameSite=Lax/Secure；TTL 7 天（spec 未定值，属产品默认——**列为待确认**：spec 强调 10 分钟短 token 为吊销手段，7 天会话不应削弱该模型，建议注释说明） |

## B-3 §5.5 部署编排

| 条款 | 判定 | 证据 |
|---|---|---|
| 九步装配（①-⑨） | **符合**（步骤齐全，顺序见 steps.ts:94-238；README 九步表） | ① D1 ② 迁移 ③ Shell ④ 模块 ⑤ registry ⑥ R2/S3 ⑦ OIDC no-op ⑧ setup token ⑨ 冒烟 |
| unself.config.jsonc 唯一配置 | 符合 | config.ts UnselfConfigSchema（domain/modules/storage）；无其他配置源 |
| 幂等（重跑收敛） | 符合 | steps.test.ts 二跑「零 create/零 secret put」；registry upsert 收敛 |
| registry 快照 | 符合（但见 A2：快照值与拓扑脱节是 §5.3 问题） | registry.ts buildManifestSnapshot → module_registry.manifest_json |
| 冒烟（/api/health + 模块 health） | 部分符合（**冒烟目标形态与真实拓扑脱节，见 A3**） | smoke.ts |
| 运行时进程不持 CF 凭证 | 符合 | wrangler.ts 仅部署期使用；JWT 私钥 `wrangler secret put`；README 声明 |
| OIDC 不进配置文件 | 符合 | config schema 无 OIDC 字段；⑦ no-op；instance_config 表 |
| setup token 打印在部署输出末尾 | 符合 | main.ts 打印 + fetchSetupToken |
| 一键入口（Deploy 按钮 + Workers Builds） | **未实现（M0 范围外说明）**：现仅 CLI（deploy/cloudflare/bin.ts + `pnpm exec`） | (b) 待后续/或明示 M0 验收不含一键按钮 |
| 失败回滚 | 部分符合：幂等重跑 ✓；git revert/CF 历史版本为流程约定（无代码） | — |
| Docker 等价（同一份 config → compose + openresty location） | **不适用（M0 未含 deploy/docker）** | M1+ |

## B-4 §6.5 前端约定

| 条款 | 判定 | 证据 |
|---|---|---|
| tokens.css 单一来源、@theme 映射、禁裸值 | 部分符合：shell/UI 全部 var(tokens) ✓（tokens.css+styles.css）；**违规：modules/hello/src/index.ts:82-92 页面内联样式裸 hex**（`--bg:#ffffff` `--border:#e4e4e1` `#fff` `48px` 等）——§6.5 明示适用于「一切自研模块前端」 | **(c) 明确违规，至今无人发现** |
| 组件查找序 beUI→shadcn→手写 | 符合（过程性） | packages/ui/src/index.ts 注释记录查找序执行结论；button.vue 注明 beUI 动效语义等价移植 |
| 基元内聚住 packages/ui | 符合 | UButton/UInput/UCard/UErrorCard；自包含无外部样式依赖 |
| Lucide 禁 emoji | 符合 | 全仓 UI 无 emoji（grep 无命中，除 contracts.test 反例断言）；lucide-vue-next 依赖 |
| 布局动线：220px 左栏/无顶栏无首页/窄屏标签栏 | 符合（微张力） | App.vue:220px sidebar+tabbar（≤768px）；nav 恒有「工作台」项——spec「无首页」与「工作台」空态视图的解释性张力：M0 直访落模块即绕开，**标注不判定** |
| setup 动线（一次性链接/三字段+测试/激活后重定向/页面不复存在） | 符合 | SetupView.vue + router.ts beforeEach + setup-guard |
| 登录一个按钮整页跳 OIDC | 符合 | LoginView.vue（无密码框）；core-api login 302 |
| 侧栏停用即消失 | 符合 | nav.ts buildNav 过滤 enabled；App.vue 空态 |
| 异常四类卡 + 人话 + request id + 管理员详情 | **部分符合**：UErrorCard 三层形状 ✓（人话+requestId+可折叠 detail）；**但后端从不产出 x-request-id**（services/core-api 无任何设置点，grep 确认），前端 `res.headers.get('x-request-id')` 恒 undefined | **(b) #22 半实现** |
| 中文写死/亮色单主题/系统字体栈 | 部分符合：中文 ✓、亮色 ✓；**系统字体栈未显式定义**（tokens.css 无 font-family 变量，全局无 body font-family 声明；仅 hello 页内联 system-ui） | (c) 轻微遗漏 |
| hello 页（身份行+计数并排） | 符合 | hello/src/index.ts 页面结构 |

## B-5 §7 部署拓扑

| 条款 | 判定 | 证据 |
|---|---|---|
| 单域名 + 路径挂载 | **偏离**（见 A 部分） | — |
| Docker 等价 | 不适用（M0 范围外） | — |
| 第三方 escape hatch（独立域名 entry） | 符合 | registry-api.ts:60-67（异域→绝对 URL）、module-bridge frameOriginFor 异域 origin |

## B-6 决策表 #1–#22 逐条

| # | 决策 | 判定 | 证据 |
|---|---|---|---|
| 1 | 自托管非 SaaS | 符合 | 架构/registry/token 全实例内闭环，无中央面 |
| 2 | CF 一键部署首选 | 部分符合（CLI 一键 ✓；**Deploy 按钮/Workers Builds 未实现**） | deploy/cloudflare/bin.ts；README |
| 3 | Docker 替代 | 不适用（M0 范围外，deploy/docker 不存在） | — |
| 4 | 通用 OIDC | 符合 | oidc.ts（发现/PKCE/callback）；setup 向导 |
| 5 | 模块可选（未启用不显示不部署） | 符合 | config.modules 驱动；未选模块 disable 语句 + enabled 过滤导航 |
| 6 | EdgeChat | 不适用（M2） | — |
| 7 | 会议 | 不适用（M4） | — |
| 8 | 日历/邮件 | 不适用（M4/M1 适配器） | — |
| 9 | monorepo | 符合 | pnpm-workspace.yaml 结构 |
| 10 | 许可证 | 部分符合：根 LICENSE=AGPL ✓、NOTICE ✓、贡献 DCO（CONTRIBUTING）✓、SPDX 头**基本**全覆盖——**apps/shell/src/styles.css 缺 SPDX 头**；third_party/components.yaml 不存在（M0 无第三方件，README 已声明「M0 登记后生效」→ 不适用+注明） | (c) 轻微 |
| 11 | 模块装载（iframe + 同域路径 + 不微前端） | 部分符合：iframe ✓；**同域路径 ✗（见 A）**；微前端未采用 ✓ | — |
| 12 | 模块身份（只验 token） | 符合 | hello verify + sdk verify.ts；模块无 OIDC 代码 |
| 13 | 单域名路径制 | **偏离（本报告 A 部分核心）** | — |
| 14 | 数据归属（2 D1/表前缀/SDK 收口/export·purge） | 基本符合 + 1 处等价替换：两 D1 ✓（migrations 0001-0003 + wrangler binds）；SDK 收口+跨前缀拒绝 ✓（storage.ts assertKey）；hello 业务表 `hello_counter` 前缀 ✓（0001_init.sql）；生命周期骨架 ✓（export/purge）；**等价替换：模块 KV 用共享表 `module_kv` + `module_id` 列**（0001_module_kv.sql 注释自论证「与表前缀契约不冲突」，SDK 键模型为 module_id 列方案）→ (a)，建议终审拍板；**微不一致：/life/export 输出 `tables.hello_counter`，实际读写走 module_kv**（export 为模拟形状） | (c) 轻微 |
| 15 | 部署编排 | 基本符合 + 路由形态偏离（见 A）；「实例不持 CF 凭证 ✓」 | — |
| 16 | M0 技术栈 | 符合 | TS/Hono/Vue3/Vite/Tailwind4(@theme)/zod/jose/pnpm/Vitest 均在用 |
| 17 | 会议记录 | 不适用（M4） | — |
| 18 | 前端约定 | 部分偏离（见 B-4：hello 裸 hex、字体栈未定义、查找序过程无法独立核实） | — |
| 19 | 手机原则 | 符合（壳双形态 ✓；PWA 明确 M6） | App.vue tabbar ≤768px |
| 20 | 身份与门户（JIT/单按钮/OIDC） | 符合 | upsertUser JIT（index.ts:210-226）；LoginView 单按钮 |
| 21 | setup 动线 | 符合 | router.ts + SetupView + 部署输出链接 |
| 22 | 可观测性 | 部分符合：UI 三层透传 ✓/audit_log ✓；**服务端不产 request id**（见 B-4）；wrangler tail 属运维惯例 | (b) 半实现 |

---

## 结论摘要

1. **§5.3 是唯一系统性偏离**，且是「计划文档正确、实现错误、注释+测试两重掩盖」的复合体：README 写 zone 路径路由（deploy/cloudflare/README.md ④、README.md:20），代码写 custom_domain 子域（assemble.ts:193/244），注释把偏离当事实（assemble.ts:191-192、smoke.ts:43、registry.ts:44、steps.ts:243），测试把偏离固化为预期（assemble.test.ts:61）。
2. #56/#57/#58 三真机 bug 同源可证：prefixStripWrapperSource（assemble.ts:298-327）是为路径制编写的代码在子域制运行时出错；smoke 的「子域+路径」幽灵 URL（smoke.ts:56-57）恰好绕开了出错分支，**冒烟全绿不能证明链路通**。
3. 回 B 方案代码改动集中于 assemble.ts/steps.ts/smoke.ts + 测试 + README（S/M 量级），**壳侧、core-api、packages、hello 零改动**；额外设计要点：zone 路由需显式 zone 标识（config 加 `zone` 字段，待定案）；部署凭证切换 API Token（用户已拍板，代码层 wrangler.ts 无需改）。
4. B 部分独立问题（非 §5.3）：§5.2 登出广播未实现、#22 request id 后端未产出、hello 页面裸 hex 违反 §6.5、styles.css 缺 SPDX 头、module_kv 表方案与「表前缀」字面契约的等价替换待终审、系统字体栈未显式定义。
5. 无把握处：zone 路由 pattern 与 zone 配置字段的具体形态（wrangler v4 语法）未在本仓库验证，标注待设计确认；beUI/shadcn 查找序的执行过程无法从仓库独立核实（仅有 ui/index.ts 声明）。
