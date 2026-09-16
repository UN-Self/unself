# M2 验收记录（2026-09-16 本地走查 + 未证实登记）

> 验收对象：首次走查 `m2/dev` 基线 `1c9dfab`（worktree `m2-issue-221`）；**#229 修复后 live 复验基线 `57a649a`（worktree `m2-issue-234`，[#234](https://github.com/UN-Self/unself/issues/234)）**
> 验收方式：**执行分级**——本地可执行项逐个实测留证（原始输出见 [#221 本地走查](./audit/221-本地走查-2026-09-16.md) 与 [#234 live 复验](./audit/234-live复验-2026-09-16.md)），真机/真云不可执行项逐条登记「未证实」（§7）
> 对应 issue：[#221](https://github.com/UN-Self/unself/issues/221)（首次走查）· [#234](https://github.com/UN-Self/unself/issues/234)（#229 修复后 live 复验 + 本文件刷新）
> 机制②三节：§5「未做」/ §6「已知限制」/ §7「未证实」

## 1. 验收结论

M2 验收标准原文（[docs/roadmap.md](./roadmap.md) M2 行）：**仅启用聊天的实例可完整使用消息与已读回执，手机端消息流可用**。

| M2 验收子项 | 结论 | 证据 / 归属 |
|---|---|---|
| 仅启用 chat 的装配（专属 D1/KV/R2 + 前端产物 + `/m/chat/*` 路由 + registry） | ✅ 本地可验证部分通过 | 装配 dry-run 产物清单（§3.1）+ #219 `chat-steps.test.ts` 命令序断言 |
| 消息收发（桌面，双端互读） | ⚠️ 部分：REST 面通过、**实时面不成立** | 浏览器 A/B live 实测（步骤③）：发送/拉取/加密落库通过；**live WS 入帧未解析 → 对方消息不实时上屏**（[#235](https://github.com/UN-Self/unself/issues/235)，audit 234 §B） |
| 手机端消息流（375×812） | ✅ 通过 | 步骤③ 375px 节 + 截图 `docs/audit/221-assets/221-03/04/05`；`scrollWidth=375` 无横向溢出；#234 复验复现（`docs/audit/234-assets/234-02/05`，`docScrollW=375`） |
| @ 提及 | ❌ 不通过 | [#230](https://github.com/UN-Self/unself/issues/230)：core 身份下 `mentionUserIds` 恒空、中文名无法过滤 |
| 文件 / 语音 | ⚠️ 部分（本地环境受限） | 本地无 R2 绑定 → 上传 503；headless 无麦克风 → 录音抛错；详见步骤③、§6 L3 |
| **逐条已读回执（A 看 B/C 递增）** | **❌ live 前端仍不通过（服务端面通过）** | 病灶一/二（[#229](https://github.com/UN-Self/unself/issues/229)）**已修复并复验通过**：mine 判定、自读过滤、`count ≤ total` 实测成立（#234，audit 234 §A）；但 **live 实时链整体失效（[#235](https://github.com/UN-Self/unself/issues/235)：WS 帧未解析）**，回执标签只在重开房间（历史补拉）后出现，「实时递增」不成立（详见 §4 步骤④） |
| 停用成员踢出（HTTP 401 + WS 1008） | ⚠️ 模块侧通过、生产传播未证实 | 模块侧 401/1008 实测通过（步骤⑤）；生产无 chat `is_disabled` 写入方（§7.3） |
| 停用模块秒级生效 / 移除后路由消失 | ⚠️ 未证实（需真云装配） | #219 命令序/三态测试 + 本次 dry-run；真实 CF 路由与 registry 待真机（§7.1） |

**总结论**：M2 走查完成。#229 修复后复验（#234，基线 `57a649a`）：**本人身份面已通过**（mine 判定 / 自读过滤 / 服务端口径），但 **「逐条已读回执」在 live 前端仍不成立**——新根因 [#235](https://github.com/UN-Self/unself/issues/235)（live WS 帧未解析 → 实时消息与实时回执全失效，只有历史补拉可见），因此 **M2 仍不满足收官条件**；待 #235 修复并复验后关单。#230、#231 为同批走查发现，建议一并在 M2 内清（收官条件见 §8）。

## 2. 执行分级

### 2.1 本地可执行（本次全部实做）

| 项 | 状态 | 证据 |
|---|---|---|
| 三件套（`pnpm -r typecheck/test/build`） | ✅ 全绿 | §3.3 |
| 红灯抽验（变异 → 红 → 还原 → 绿，2 处） | ✅ 完成 | §3.2 |
| 装配 dry-run（仅启用 chat，零网络零 CF） | ✅ 完成 | §3.1 |
| `wrangler dev` 双端互读（浏览器走查桌面 + 375px） | ✅ 完成 | 步骤①-④ |
| 回执递增（HTTP + WS 推送帧） | ⚠️ 服务端面通过；**实时前端面不通过** | 服务端（步骤④）+ audit 234 §A.3；live 实时链根因 [#235](https://github.com/UN-Self/unself/issues/235)（audit 234 §B） |
| 停用成员踢出（HTTP 401 + WS 1008） | ✅ 模块侧通过 | 步骤⑤ |
| 令牌过期（生产等同的吊销上限） | ✅ 通过 | audit 221 §C.7 |
| **#234 复验（基线 `57a649a`，`wrangler dev` + live 前端）** | ⚠️ 部分通过 | mine 判定 / 自读过滤 / DM mine = ✅；实时推送与实时回执 = ❌（[#235](https://github.com/UN-Self/unself/issues/235)）→ [docs/audit/234-live复验-2026-09-16.md](./audit/234-live复验-2026-09-16.md) |

### 2.2 真机 / 真云不可执行（登记为「未证实」→ §7）

无 CF API Token、无真机、无真实邮件服务器，因此以下项**本次未执行**：真实装配九步、真机 `team.handywote.top` 式生产走查（含登录壳 → iframe 握手）、平台 cron、三端以上真机互读、真机触摸/软键盘/横屏。

## 3. 本地可执行项证据（摘要）

### 3.1 装配 dry-run（仅启用 chat）

`deploy/cloudflare/scripts/dry-run-chat.ts`（本次走查临时脚本，未入库；全文见 audit 文档附录）调用生产 `provisionAll` + `buildChatFrontendAssets`，**零 wrangler 调用**（stub 一旦被调用即抛错），产物落 `.deploy/cloudflare/`（gitignored）：

```
✓ core.wrangler.jsonc 792B          ✓ modules/chat/wrangler.jsonc 2059B
✓ modules/chat/worker.js（wrapper） 1739B   ✓ modules/chat/app.js（bundle） 998727B
✓ modules/chat/assets/frontend/index.html 400B   ✓ assets/sdk/module-sdk.esm.js 771870B
✓ assets/shell/index.html 393B
chat.wrangler.jsonc: main=chat/worker.js · assets.directory=chat/assets/frontend(run_worker_first=true)
  d1=unself-chat · kv=SESSIONS · r2=FILES(unself-chat-files) · DO=[CHANNEL_ROOM,SCHEDULER,USER_INBOX]
  migrations=v1(new_sqlite_classes=3) · vars.MODULE_ID=chat · CORE_JWKS_JSON=1 key · observability.enabled
wrapper: ✓ const PREFIX = '/m/chat'
```

> 上传面（`wrangler deploy`/`d1 create`/registry upsert/路由）无 CF 凭证不能真跑，由 #219 的录制型 fake wrangler 命令序测试（`deploy/cloudflare/test/chat-steps.test.ts`，199 用例全绿）锚定。

### 3.2 红灯抽验（新基线 `1c9dfab` 上独立复验）

| 变异（单文件） | 观测 | 还原后 |
|---|---|---|
| `modules/chat/worker/src/api/messages.js`：`denominator = Math.max(0, memberCount-(isOwn?1:0))` → `memberCount` | **2 红**（单聊 total、群聊 count） | 11 绿 |
| `modules/chat/frontend/src/lib/chat-store.ts`：回执幂等守卫 `if (summary && …)` → `if (summary && false && …)` | **1 红**（重复帧幂等/递增） | 15 绿 |

两次变异均在还原后核验源码回原样、`git status` 干净（原始输出见 audit 文档）。

### 3.3 三件套

`pnpm -r typecheck && pnpm -r test && pnpm -r build` 全绿：typecheck 全部 Done；test 962 passed / 0 failed（含 `modules/chat` 36、`modules/chat/frontend` 90、`deploy/cloudflare` 199、`services/core-api` 256、`apps/shell` 197）；build 全部 Done。

### 3.4 #234 复验要点（基线 `57a649a`，原始输出见 audit 234）

- **✅ mine 判定（#229 病灶一+二已修）**：live 下 `state.myUserId` = 1（core `sub=1` 经 `contacts.username === 'core:1'` 精确映射到 chat id 1），本人气泡 `bubble-mine` + 回执标签渲染；乙侧同消息为 `bubble-theirs`。
- **✅ 自读过滤**：甲发出消息后网络面无 `POST /api/messages/read`；混合房间（含他人消息）重开房间时上报体只含他人消息 id（`messageIds:[7]`）。服务端自读兜底：甲强报自己的消息 → `receipts: []`（零落行零广播），`readBy` 永不含发件人，`count ≤ total`。
- **✅ DM 口径**：DM mine 判定正确、`已读 ✓✓` 标签可渲染（历史补拉后）；`total=1`。
- **✅ 375×812**：`vw=375` / `docScrollW=375`，mine 气泡 + 回执标签正常。
- **❌ 实时面（[#235](https://github.com/UN-Self/unself/issues/235)）**：live WS 入帧是 JSON 字符串、未经 `JSON.parse` 就交给 `receiveRoomFrame`（`api.ts:162`）→ 所有实时帧判型失败被静默丢弃：对方消息不实时上屏、已读回执不实时更新（DM 同）。浏览器内补一层 `JSON.parse`（正对照）后实时链立即恢复；同一次正对照暴露「自消息回显/REST 回包竞态」次生缺陷（自己的消息不上屏）。

## 4. 七步验收剧本（M2）

> 剧本设计目标：干净装配仅启用 chat → 管理员/成员进入 → 桌面收发/@/文件/语音 → 逐条回执 → 停用成员踢出 → 停用模块秒级生效 → 移除后路由消失。
> 本次执行方式：**装配面**用 dry-run + #219 测试；**运行面**用 `wrangler dev`（chat worker 8791）+ live 前端（vite 8792，`/api` 代理到 worker；#234 复验改用 8793，该端口被上一会话残留进程占用）+ `mint-token.mjs` 直发模块 token（对齐 core `issueModuleToken` 形状：ES256/aud=chat/10 分钟）。

### 步骤 ①：干净装配（仅启用 chat）

- **结论**：✅ 本地可验证部分通过（真云装配未证实）。
- **证据**：§3.1 产物清单；`unself.config.jsonc` 示例仍为 `["hello"]`（启用 chat 是部署者行为，未改配置）；chat 专属 D1/KV/R2 与基线 schema 灌入路径由 #219 命令序测试锚定（`d1 execute --file schema-baseline.sql --remote`，不走 migrations 链）。
- **未证实**：真实 CF 上九步上传、DNS/证书、registry 落库、冒烟（§7.1）。

### 步骤 ②：管理员 / 成员进入

- **结论**：⚠️ 部分（模块身份面通过；core 壳登录 → iframe 握手未证实）。
- **证据（模块侧）**：JIT 建档实测——首见 `sub=1`/`sub=2` 令牌即建行（`users.username = core:1 / core:2`），general 频道入席由 schema 触发器兜底（`memberCount` 1→2→3）；未认证请求 401。
- **#234 补充（live 身份映射）**：三成员（`sub=1/2/3` → chat id `1/8/35`，非同一命名空间）实测 `state.myUserId` 与 contacts 映射一致；令牌超出 10 分钟窗口后 HTTP 401、WS 被服务端关闭（与 L1 一致）。
- **未证实**：core-api 登录 → `POST /api/modules/:id/token` → 壳 postMessage 下发 → SDK 静默续期的完整链路（本地未跑 core 壳，§7.2）。

### 步骤 ③：桌面收发 / @ / 文件 / 语音

- **收发**：⚠️ 部分（REST 面通过；**实时面不成立**）。A（sub=1）浏览器发消息 → `POST /api/v1/rooms/public/1/messages 200`；B 侧 WS 建连成功（`GET /api/ws/public/1 101`）但 **live 前端不解析入帧 → 对方消息不实时上屏**（#234 实测：甲重开房间触发历史补拉后才出现；根因 [#235](https://github.com/UN-Self/unself/issues/235)）；服务端密文落库由 #216 证据沿用。
- **@**：❌ 不通过（#230）。浮层仅空查询可列出全部候选；输入中文展示名（`@走`）浮层直接关闭；键盘选中插入 `@core:2`，但发送后 `messages.mention_user_ids = "[]"`。
- **文件**：⚠️ 本地环境受限。`POST /api/upload 503`（未绑定 R2，worker 人话文案「当前部署没有绑定 R2，无法上传附件」）；`pending-file` 预览保留，但**界面无失败提示**（详见 §6 L3）。
- **语音**：⚠️ 本地环境受限。headless Chromium 无麦克风 → `record-start` 抛未捕获错误（`[Vue warn] Unhandled error during execution of component event handler`），**界面无提示**。

### 步骤 ④：逐条回执（A 看 B/C 的已读递增）

- **服务端面**：✅ 通过。乙读 → `read_receipts` 落行 + DO 聚合广播（帧实收：node 取证客户端直连 worker 的 `{type:'read_receipts', messageId, userId, readAt, messageIds}`，批内合并实测 batch=4 一帧）；分页富化 `readReceipts{count,readBy,total}` 正确；重放同批 → `receipts: []` 零新增零事件（幂等）。**注：该广播帧在浏览器 live 前端因 [#235](https://github.com/UN-Self/unself/issues/235) 未被处理（见下条）。**
- **前端面（本人身份，[#229](https://github.com/UN-Self/unself/issues/229)）**：✅ **已修复并复验通过**（#234，基线 `57a649a`）。live 下本人消息渲染为 `bubble-mine` 且回执标签出现；自读不再上报（发出后无 `POST /api/messages/read`；混合房间重开房间的上报体只含他人消息 id）；服务端自读兜底实测 `receipts: []`，`readBy` 永不含发件人，`count ≤ total`（不再出现 `已读 2/1`）。
- **前端面（实时递增，[#235](https://github.com/UN-Self/unself/issues/235)）**：❌ **不通过**。live 的 WS 入帧是 JSON 字符串、未经 `JSON.parse`（`modules/chat/frontend/src/lib/api.ts:162`）就交给 `receiveRoomFrame`，判型恒 false → `message` / `read_receipts` 帧全部静默丢弃；表现：乙读后甲侧回执标签不更新，需重开房间（历史补拉）才刷新；DM 同。浏览器内补一层 `JSON.parse`（正对照，未落代码）后实时链立即恢复（含实时回执）。证据见 audit 234 §B。

### 步骤 ⑤：停用成员踢出（HTTP 401 + WS 1008）

- **结论**：⚠️ 模块侧通过；生产传播链未证实。
- **证据**：置 chat 库 `users.is_disabled = 1`（模拟模块侧停用复查路径）后——HTTP `GET /api/channels` → `401 {"error":"账号已停用"}`；已建连 WS 下一业务帧 → `close code=1008 reason=Unauthorized`（决策 #51「按消息重验」）。
- **#234 备注**：本项未重跑（结论沿用 #221）；[#235](https://github.com/UN-Self/unself/issues/235) 影响的是**入帧判型**，不改变 1008 关闭语义。
- **未证实**：生产实际传播 = core 管理台停用（写 core 库 + audit，不触 chat 库）+ 停止签发/续期 → 存量模块 token 到期即失效（≤10 分钟）；chat 库 `is_disabled` **当前无任何写入方**（§7.3）。

### 步骤 ⑥：停用模块秒级生效

- **结论**：⚠️ 未证实（需真云）。
- **依据**：#219 测试断言「未选/停用 → `UPDATE module_registry SET enabled = 0` + 删除 zone 路由 + 不部署 Worker/不动数据」；本次 dry-run 不覆盖 registry 写面（需 D1 远程）。
- **补充**：模块内已无 chat admin 面（#216 裁剪），模块级「停用」语义完全由 core registry + 路由门禁承载。

### 步骤 ⑦：移除后路由消失

- **结论**：⚠️ 未证实（需真云）。
- **依据**：同 ⑥（`not_deployed` 语义 + 路由删除 + Worker/D1 保留）；本地无 zone 路由概念，wrangler dev 单进程不体现。

## 5. 未做（范围内声明但未执行）

| 项 | 原因 | 归属 |
|---|---|---|
| 真实 CF 装配 + 真机端到端走查（步骤 ①②⑥⑦ 的云端部分） | 无 CF API Token（本会话环境）；不碰真实 CF 资源是任务硬边界 | M2 复验 / 下次真机走查 |
| core 壳登录 → iframe 握手 → token 续期的完整链路 | 本地只起 chat worker + live 前端，未起 core-api/shell（避免与真云语义混淆） | M2 复验 |
| 三端（A/B/C）**真机**互读（本次做了浏览器双端 + API 三成员口径） | 双浏览器已覆盖身份/mine 判定；但 UI 实时「递增」因 [#235](https://github.com/UN-Self/unself/issues/235) 不成立，真机取证需待修复 | 下次真机走查（#235 修复后） |
| 平台 cron（SCHEDULER DO 驱动的 GC）真实周期核验 | 本地 wrangler dev 不启平台 cron（wrangler.jsonc 有意不配 crons） | 继承 #219 遗留 2 |
| mock 视觉走查完整交互 | 本次重点为 live 实测；mock 仅观察到会话列表渲染 | 待 [#235](https://github.com/UN-Self/unself/issues/235) 修复后补 |
| chat 模块「管理员」视角（admin 面） | #216 已整体裁剪 admin 路由（决策 #50 固定搬运范围） | 非 M2 范围 |

## 6. 已知限制（做完了但有限定条件）

| # | 项 | 限定条件 |
|---|---|---|
| L1 | 模块 token 签出后到期前不可吊销 | 模块侧只验签 + 过期；「用户未停用」复查路径在 unself 下无写入方（§7.3）。真实踢出上限 = token 时效（≤10 分钟）。重启实例/重装不改变此性质 |
| L2 | 本地 live 走查用 `mint-token.mjs` 直发令牌 | 形状与 core `issueModuleToken` 对齐（ES256/kid=RFC7638/iss=unself-core/aud=chat/10 分钟），但**未经过 core 签发接口**；因此「core 侧签发」链路的证据不在本次走查内（§7.2） |
| L3 | 文件/语音仅在「本地无 R2、headless 无麦克风」条件下观察 | 上传 503 是缺绑定的预期降级，不构成对 R2 路径的复核；语音未覆盖任何真实录制路径 |
| L4 | 375×812 为桌面 Chromium 视口模拟（deviceScaleFactor=2） | 未覆盖真机触摸命中率、软键盘弹起、横屏、320px；与 M1 §8 L4 同款限定 |
| L5 | 走查数据库为本地 miniflare D1/DO/KV 状态（`.wrangler/state`） | `users.id` 因 `INSERT OR IGNORE`+AUTOINCREMENT 产生空洞（实测 sub=1→id1、sub=2→id11、sub=3→id38）；这是本地断言「core sub ≠ chat 内部 id」的现场，不代表生产分布 |
| L6 | 装配 dry-run 不含 `wrangler` 上传面 | `provisionAll` 只做构建与配置生成；真实资源创建/路由/registry 由 #219 命令序测试代表 |
| L7 | #234 复验的 live 令牌为一次性注入（`mint-token.mjs`，10 分钟），无壳续期 | 超出窗口后 HTTP 401、WS 被服务端关闭（实测）；复验均在有效窗口内完成，续期链路仍归 §7.2 |
| L8 | #234 的「解析补丁」正对照是浏览器运行期 monkeypatch | 仅用于证明实时链只差 `JSON.parse`；不落代码、不构成修复（修复归 #235） |

## 7. 未证实（声称完成但缺证据链 → 写明缺什么、谁来补）

### 7.1 真实云装配与生产走查

- **缺什么**：CF API Token + 目标域名/DNS 权限；装配九步真实执行的命令输出；`/m/chat/*` 路由与 `/api/health` 冒烟原文；registry `module_registry` 行原文。
- **谁来补**：部署者（持 token）跑 `node deploy/cloudflare/bin.ts`，按本文件 §4 步骤 ①②⑥⑦ 复走；产出落 `docs/audit/`。

### 7.2 core 壳 → 模块 token 全链路

- **#234 部分收缩**：模块侧 live 前端已用真 ES256 令牌（`mint-token.mjs`，对齐 core `issueModuleToken` 形状）复验：身份映射（`core:<sub>` → chat id）、mine 判定、自读过滤均通过；「实时已读 n/m 递增」因 [#235](https://github.com/UN-Self/unself/issues/235) 仍不成立。
- **仍缺什么**：core 登录会话、`POST /api/modules/:id/token` 响应、壳 postMessage 下发与 SDK 续期日志（含 `token_refresh` 控制帧 ack——该 ack 同样被判型缺陷吞掉，#235）。
- **谁来补**：本地起 core-api + shell（或真云实例）做端到端；覆盖「登录 → iframe 载入 → 本人消息 mine → 已读 n/m 递增」，且需在 #235 修复后。

### 7.3 停用成员的真实传播链

- **缺什么**：core 管理台停用 → 存量模块 token 失效的全链路证据（401/1008 的**触发源**是 core 而非直接改 chat 库）。
- **现状（代码面已核）**：`services/core-api/src/routes/members.ts` 只写 core 库（+audit，可选邮件联动）；chat 库 `users.is_disabled` 在 `modules/chat/worker/src/**` 与 `services/core-api/src/**` 中**只有读、没有写**。故生产踢出 = 停止签发 + token 到期；「即时踢出」不成立（与 L1 一致）。
- **谁来补**：真实实例停用一名成员，记录该成员 HTTP/WS 表现随时间（≤10 分钟）的变化。

### 7.4 三端真机互读

- **缺什么**：A/B/C 三台真实客户端（含真机）的「已读 n/m 递增」同屏证据；#234 复验为三成员 API 口径 + 双浏览器（甲/乙浏览器 + 丙 curl），仍非真机；且实时递增面需待 #235 修复后才可能在 UI 上同屏取证。
- **谁来补**：下次真机走查（#235 修复后）。

### 7.5 SESSIONS KV 残件的实际影响面

- 已实证写入仍在（#231）；**缺**的是生产 KV 导出面与备份策略的核对。归属 #231 关闭时补。

### 7.6 live 实时链（新增证据缺口）

- **缺什么**：live 实时面（对方消息实时上屏 / 实时已读回执 / 未读投影）的通过证据——#234 已实测「不成立」并定位根因 → [#235](https://github.com/UN-Self/unself/issues/235)。
- **谁来补**：修复 #235 后重跑本文件 §4 步骤③④（含 DM），并用「不重开房间」的实时取证（DOM + WS 帧）替代历史补拉证据。

## 8. 未决与交接（并入 roadmap「未决与交接」）

| 项 | 归属 |
|---|---|
| ~~#229 live `myUserId` 恒 0 → mine/回执面不可见~~ | **已修复并复验（#234，基线 `57a649a`）：mine 判定/自读过滤/服务端口径均通过** |
| [#235](https://github.com/UN-Self/unself/issues/235) live WS 帧未解析（`api.ts:162`）→ 实时消息/实时回执全失效（**M2 收官阻塞项**） | M2 修复 + 复验 |
| #230 @ 提及与 `core:` 身份不兼容（mentionUserIds 恒空/中文名无法过滤） | M2 |
| #231 SESSIONS KV 残件仍有写入（PATCH profile 落明文 JWT，TTL 7 天） | M2 |
| 真实 CF 装配 + 真机端到端（含步骤 ①②⑥⑦） | 下次真机走查（部署者持 token） |
| GC cron 真实周期（SCHEDULER DO） | M3 前 |
| 三端真机互读 | #235 修复复验时 |
| chat 前端产物含 `dev-shim.html`（dev-only 页面随 assets 部署） | 走查观察项，建议 M2 收口时清理（低危：shim 只能签发未签名假令牌，被 worker 拒绝） |

**M2 关单条件（机制⑤）当前判定**：issue 未清零（#235/#230/#231 在 M2 名下）→ **不满足**；#229 已修复并复验通过（mine 判定/自读过滤），但复验中发现 #235（live 实时链）为**新阻塞项**，待其修复并复验后，本文件 §1 结论与 roadmap「当前状态」再一并更新。

## 9. 验收资产

- 走查原始输出（红灯/dry-run/双端 live/停用/过期/375px）：`docs/audit/221-本地走查-2026-09-16.md`
- 截图（375px 与桌面）：`docs/audit/221-assets/221-01…05-*.png`
- **#234 复验原始输出**（mine/自读过滤/服务端兜底/DM/实时面探针/正对照）：`docs/audit/234-live复验-2026-09-16.md`
- **#234 复验截图**：`docs/audit/234-assets/234-01…05-*.png`（桌面 mine+回执、375px 消息流、DM 已读 ✓✓）
- 复现配方（本地 live 走查）：audit 文档「环境配方」节（`.dev.vars`、`mint-token.mjs`、vite live 代理、辅助脚本全文）；#234 探针脚本全文见 audit 234 §E
- 相关测试：`modules/chat/test/chat-read-receipts.test.ts`、`chat-ws-renewal.test.ts`、`chat-messages.test.ts`、`modules/chat/frontend/test/read-receipts.test.ts`、`deploy/cloudflare/test/chat-*.test.ts`（**注：#235 的 live WS 入参解析无任何测试覆盖**）
