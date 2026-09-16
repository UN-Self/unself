# M2 验收记录（2026-09-16 本地走查 + 未证实登记）

> 验收对象：首次走查 `m2/dev` 基线 `1c9dfab`（worktree `m2-issue-221`）；#229 修复后 live 复验基线 `57a649a`（[#234](https://github.com/UN-Self/unself/issues/234)）；**修复波次后终验基线 `bb9b679`（含 [#229](https://github.com/UN-Self/unself/issues/229)/[#235](https://github.com/UN-Self/unself/issues/235)/[#230](https://github.com/UN-Self/unself/issues/230)/[#231](https://github.com/UN-Self/unself/issues/231) 全部修复，[#239](https://github.com/UN-Self/unself/issues/239)）**
> 验收方式：**执行分级**——本地可执行项逐个实测留证（原始输出见 [#221 本地走查](./audit/221-本地走查-2026-09-16.md)、[#234 live 复验](./audit/234-live复验-2026-09-16.md)、[#239 live 终验](./audit/239-live终验-2026-09-16.md)），真机/真云不可执行项逐条登记「未证实」（§7）
> 对应 issue：[#221](https://github.com/UN-Self/unself/issues/221)（首次走查）· [#234](https://github.com/UN-Self/unself/issues/234)（#229 复验）· [#239](https://github.com/UN-Self/unself/issues/239)（修复波次后 live 终验 + 本文件翻绿刷新）
> 机制②三节：§5「未做」/ §6「已知限制」/ §7「未证实」

## 1. 验收结论

M2 验收标准原文（[docs/roadmap.md](./roadmap.md) M2 行）：**仅启用聊天的实例可完整使用消息与已读回执，手机端消息流可用**。

| M2 验收子项 | 结论 | 证据 / 归属 |
|---|---|---|
| 仅启用 chat 的装配（专属 D1/KV/R2 + 前端产物 + `/m/chat/*` 路由 + registry） | ✅ 本地可验证部分通过 | 装配 dry-run 产物清单（§3.1）+ #219 `chat-steps.test.ts` 命令序断言 |
| 消息收发（桌面，双端互读） | ✅ 通过（#239 终验翻绿） | 实时面修复后实测：乙发 → 甲**不重开房间**实时上屏（探针帧序 `message mid=2`），自消息竞态不重现（`dup3=1` 零重复）；REST 面维持通过（§3.5、步骤③） |
| 手机端消息流（375×812） | ✅ 通过 | 步骤③ 375px 节 + 截图 `docs/audit/221-assets/221-03/04/05`；`scrollWidth=375` 无横向溢出；#234 复验复现（`docs/audit/234-assets/234-02/05`，`docScrollW=375`） |
| @ 提及 | ✅ 通过（#239 终验翻绿） | [#230](https://github.com/UN-Self/unself/issues/230) 修复后实测：`@走`（中文）浮层保留候选；`@core:2` 发送落库 `mentionUserIds=[6]`；`@走查乙`（展示名直输）前端不产 id、服务端按 content 复核过滤——口径与取舍得名（步骤③） |
| 文件 / 语音 | ⚠️ 部分（本地环境受限） | 本地无 R2 绑定 → 上传 503；headless 无麦克风 → 录音抛错；详见步骤③、§6 L3 |
| **逐条已读回执（A 看 B/C 递增）** | ✅ 通过（#239 终验翻绿） | [#229](https://github.com/UN-Self/unself/issues/229) 身份面（#234 已证）+ [#235](https://github.com/UN-Self/unself/issues/235) 实时面修复后实测：乙读 → 甲**不重开房间**实时收到 `read_receipts` 帧且回执 `count` 递增（DM `已读 ✓✓` 同）；自读过滤全程成立（详见 §4 步骤④） |
| 停用成员踢出（HTTP 401 + WS 1008） | ⚠️ 模块侧通过、生产传播未证实 | 模块侧 401/1008 实测通过（步骤⑤）；生产无 chat `is_disabled` 写入方（§7.3） |
| 停用模块秒级生效 / 移除后路由消失 | ⚠️ 未证实（需真云装配） | #219 命令序/三态测试 + 本次 dry-run；真实 CF 路由与 registry 待真机（§7.1） |

**总结论**：M2 本地可验证范围**全部通过**。修复波次（#229 身份面 → #235 实时面 → #230 提及 → #231 KV 残件）后终验（#239，基线 `bb9b679`）：**实时消息、实时已读回执、@ 提及、DM、375px 全链实测成立**（不重开房间取证，§3.5）；未证实项收敛为真机/真云 5 条（§7），不再含本地可执行缺陷。**M2 满足机制⑤收官条件**（收官判定材料见 §8）。

## 2. 执行分级

### 2.1 本地可执行（本次全部实做）

| 项 | 状态 | 证据 |
|---|---|---|
| 三件套（`pnpm -r typecheck/test/build`） | ✅ 全绿 | §3.3 |
| 红灯抽验（变异 → 红 → 还原 → 绿，2 处） | ✅ 完成 | §3.2 |
| 装配 dry-run（仅启用 chat，零网络零 CF） | ✅ 完成 | §3.1 |
| `wrangler dev` 双端互读（浏览器走查桌面 + 375px） | ✅ 完成 | 步骤①-④ |
| 回执递增（HTTP + WS 推送帧） | ✅ 服务端+实时前端面均通过 | 服务端（步骤④）+ audit 234 §A.3；实时面前端由 [#235](https://github.com/UN-Self/unself/issues/235) 修复后终验实测（§3.5） |
| 停用成员踢出（HTTP 401 + WS 1008） | ✅ 模块侧通过 | 步骤⑤ |
| 令牌过期（生产等同的吊销上限） | ✅ 通过 | audit 221 §C.7 |
| **#234 复验（基线 `57a649a`，`wrangler dev` + live 前端）** | ⚠️ 部分通过（已被 #239 终验取代） | mine 判定 / 自读过滤 / DM mine = ✅；实时推送与实时回执 = ❌（当时 [#235](https://github.com/UN-Self/unself/issues/235) 未修）→ [docs/audit/234-live复验-2026-09-16.md](./audit/234-live复验-2026-09-16.md) |
| **#239 终验（基线 `bb9b679`，修复波次后全链 live）** | ✅ 全链通过 | 实时上屏/实时回执递增/自消息竞态/@提及/DM ✓✓/375px 均实测（§3.5）→ [docs/audit/239-live终验-2026-09-16.md](./audit/239-live终验-2026-09-16.md) |

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

`pnpm -r typecheck && pnpm -r test && pnpm -r build` 全绿。终验基线 `bb9b679`：test **975 passed / 0 failed**（含 `modules/chat` 39、`modules/chat/frontend` 100、`deploy/cloudflare` 199、`services/core-api` 256、`apps/shell` 197）；typecheck 0 error；build 全部 Done。（#229 波 963 → #235 波 973 → #230/#231 波 975，红灯证据随各 PR：`/tmp/tasks/evidence-{229,235,230}-redlight.md` 精神已摘录进对应 PR 描述）

### 3.4 #234 复验要点（基线 `57a649a`，原始输出见 audit 234）

- **✅ mine 判定（#229 病灶一+二已修）**：live 下 `state.myUserId` = 1（core `sub=1` 经 `contacts.username === 'core:1'` 精确映射到 chat id 1），本人气泡 `bubble-mine` + 回执标签渲染；乙侧同消息为 `bubble-theirs`。
- **✅ 自读过滤**：甲发出消息后网络面无 `POST /api/messages/read`；混合房间（含他人消息）重开房间时上报体只含他人消息 id（`messageIds:[7]`）。服务端自读兜底：甲强报自己的消息 → `receipts: []`（零落行零广播），`readBy` 永不含发件人，`count ≤ total`。
- **✅ DM 口径**：DM mine 判定正确、`已读 ✓✓` 标签可渲染（历史补拉后）；`total=1`。
- **✅ 375×812**：`vw=375` / `docScrollW=375`，mine 气泡 + 回执标签正常。
- **❌ 实时面（[#235](https://github.com/UN-Self/unself/issues/235)）**：live WS 入帧是 JSON 字符串、未经 `JSON.parse` 就交给 `receiveRoomFrame`（`api.ts:162`）→ 所有实时帧判型失败被静默丢弃：对方消息不实时上屏、已读回执不实时更新（DM 同）。浏览器内补一层 `JSON.parse`（正对照）后实时链立即恢复；同一次正对照暴露「自消息回显/REST 回包竞态」次生缺陷（自己的消息不上屏）。

### 3.5 #239 终验要点（基线 `bb9b679`，原始输出见 audit 239）

> 环境：`wrangler dev` 8791（干净库 + `mint-token.mjs` 真 ES256 令牌）+ vite live 8793（`/api` 含 WS 代理）+ agent-browser 双会话（甲 `sub=1`→chat id 1、乙 `sub=2`→chat id 6）。全部断言**不重开房间**。

- **✅ 实时消息上屏（#235 修复面）**：乙发 → 甲侧 `msgs:[1,2]` 即时出现（探针帧序 `message mid=2`），无需历史补拉。
- **✅ 自消息竞态（#235 次生修复面）**：甲发 msg3 → 甲侧 `msgs:[1,2,3]`、`dup3=1`（WS 回显先入列，REST 回包幂等去重）；乙侧同帧实时收到。
- **✅ 实时回执递增**：甲探针帧序 `read_receipts`（`userId=6`）→ `state.readReceipts[3].count=1`（乙读甲消息，甲不重开房间）。
- **✅ @ 提及（#230 修复面）**：`@走` 浮层保留候选（「走查乙 @core:2 / 走查甲 @core:1」）；发送 `@core:2 …` → 服务端 `mentionUserIds=[6]`（乙的 chat id）。
- **✅ DM 全链**：甲在 DM 发言 → 乙实时收到（`msgs:[8]`）；乙已读 → 甲实时收 `read_receipts` 帧（探针 `t=read_receipts`）；重拉后 `count=1/total=1`、标签「已读 ✓✓」、已读名单浮层列「走查乙」。
- **✅ 自读过滤全程**：服务端复查 `readBy` 永不含发件人、`count ≤ total`（违规条目：无）。
- **✅ 375×812**：`vw=375`、`overflow=false`，消息流与 DM ✓✓ 标签正常（截图 239-06/07）。

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

- **收发**：✅ 通过（#239 终验翻绿）。REST 面维持通过；实时面由 [#235](https://github.com/UN-Self/unself/issues/235) 修复后实测：乙发 → 甲**不重开房间**即时上屏（探针帧序 `message mid=2`）；甲发 → 甲乙两侧均即时上屏且零重复（自消息竞态修复面，`dup3=1`）。
- **@**：✅ 通过（#239 终验翻绿，[#230](https://github.com/UN-Self/unself/issues/230) 修复）。`@走`（中文）浮层保留全部命中候选；键盘选中插入 `@core:2`；发送后服务端 `mentionUserIds=[6]` 落库；`@走查乙`（展示名直输）前端不产 id → 服务端按 content 含 `@<username>` 复核过滤为空——与单测口径一致，展示名直输的完整支持归服务端口径调整（§8 交接）。
- **文件**：⚠️ 本地环境受限。`POST /api/upload 503`（未绑定 R2，worker 人话文案「当前部署没有绑定 R2，无法上传附件」）；`pending-file` 预览保留，但**界面无失败提示**（详见 §6 L3）。
- **语音**：⚠️ 本地环境受限。headless Chromium 无麦克风 → `record-start` 抛未捕获错误（`[Vue warn] Unhandled error during execution of component event handler`），**界面无提示**。

### 步骤 ④：逐条回执（A 看 B/C 的已读递增）

- **服务端面**：✅ 通过。乙读 → `read_receipts` 落行 + DO 聚合广播（帧实收：node 取证客户端直连 worker 的 `{type:'read_receipts', messageId, userId, readAt, messageIds}`，批内合并实测 batch=4 一帧）；分页富化 `readReceipts{count,readBy,total}` 正确；重放同批 → `receipts: []` 零新增零事件（幂等）。**注：该广播帧在浏览器 live 前端因 [#235](https://github.com/UN-Self/unself/issues/235) 未被处理（见下条）。**
- **前端面（本人身份，[#229](https://github.com/UN-Self/unself/issues/229)）**：✅ **已修复并复验通过**（#234，基线 `57a649a`）。live 下本人消息渲染为 `bubble-mine` 且回执标签出现；自读不再上报（发出后无 `POST /api/messages/read`；混合房间重开房间的上报体只含他人消息 id）；服务端自读兜底实测 `receipts: []`，`readBy` 永不含发件人，`count ≤ total`（不再出现 `已读 2/1`）。
- **前端面（实时递增，[#235](https://github.com/UN-Self/unself/issues/235)）**：✅ **通过（#239 终验翻绿）**。`parseSocketFrame` 修复（live 字符串帧 → 解析后交上层，坏帧静默丢弃）+ 自消息回显幂等入列后实测：乙读甲消息 → 甲**不重开房间**收到 `read_receipts` 帧（探针 `t=read_receipts, userId=6`）且回执递增；DM 甲发言 → 乙实时收（`msgs:[8]`）→ 乙读 → 甲实时收帧、重拉后 `count=1/total=1`「已读 ✓✓」。证据见 audit 239 §A。

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
| 三端（A/B/C）**真机**互读（已做浏览器双端实时链 + API 三成员口径） | 技术阻塞已清（#235 修复后 #239 终验通过）；仅缺真机设备与部署者 token | 下次真机走查 |
| 平台 cron（SCHEDULER DO 驱动的 GC）真实周期核验 | 本地 wrangler dev 不启平台 cron（wrangler.jsonc 有意不配 crons） | 继承 #219 遗留 2 |
| mock 视觉走查完整交互 | 本次重点为 live 实测；mock 仅观察到会话列表渲染 | 待真机走查一并补 |
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

- **#239 再收缩**：模块侧 live 前端全链（身份映射、mine 判定、自读过滤、实时消息、实时已读 n/m 递增、@ 提及、DM）已在修复波次后全部实测通过；`token_refresh` 控制帧的入帧解析面同享 #235 修复（#51 换绑语义另有 #217 测试锚定）。
- **仍缺什么**：core 登录会话、`POST /api/modules/:id/token` 响应、壳 postMessage 下发与 SDK 静默续期的运行日志。
- **谁来补**：部署者（本地起 core-api + shell，或真云实例）做端到端走查。

### 7.3 停用成员的真实传播链

- **缺什么**：core 管理台停用 → 存量模块 token 失效的全链路证据（401/1008 的**触发源**是 core 而非直接改 chat 库）。
- **现状（代码面已核）**：`services/core-api/src/routes/members.ts` 只写 core 库（+audit，可选邮件联动）；chat 库 `users.is_disabled` 在 `modules/chat/worker/src/**` 与 `services/core-api/src/**` 中**只有读、没有写**。故生产踢出 = 停止签发 + token 到期；「即时踢出」不成立（与 L1 一致）。
- **谁来补**：真实实例停用一名成员，记录该成员 HTTP/WS 表现随时间（≤10 分钟）的变化。

### 7.4 三端真机互读

- **缺什么**：A/B/C 三台真实客户端（含真机）的「已读 n/m 递增」同屏证据。#239 终验已覆盖双浏览器实时链（不重开房间），桌面/375 视口；仍非真机。
- **谁来补**：下次真机走查（技术阻塞已清，仅缺设备）。

### 7.5 SESSIONS KV 生产残件核对（#231 已停写，生产面待核）

- 代码面已清零（#231：停写 + 本地会话机制下架 + 装配注释明示「无写入方」）；**缺**的是生产实例 KV 导出/备份里历史条目的核对（本地已实证新写入为零）。
- **谁来补**：部署者在真云实例抽查 SESSIONS KV（应无新增条目；历史条目随 TTL 自然过期）。

### 7.6 ~~live 实时链~~（已证实 → 移出未证实）

- #239 终验已用「不重开房间」的实时取证（DOM + WS 帧探针）覆盖：实时上屏、实时回执递增、自消息竞态、DM、@ 提及（§3.5）。**不再构成证据缺口**。

## 8. 未决与交接（并入 roadmap「未决与交接」）

| 项 | 归属 |
|---|---|
| ~~#229 live `myUserId` 恒 0 → mine/回执面不可见~~ | ✅ 已修复并复验（#234）+ 终验（#239） |
| ~~#235 live WS 帧未解析 + 自消息竞态~~ | ✅ 已修复（PR #237）+ 终验实测（#239，不重开房间取证） |
| ~~#230 @ 提及与 `core:` 身份不兼容~~ | ✅ 已修复（PR #238）+ 终验实测（`@走` 浮层 / `@core:2` 落库 `[6]`） |
| ~~#231 SESSIONS KV 残件写入（明文 JWT，TTL 7 天）~~ | ✅ 已修复（PR #238：停写+下架；装配绑定过渡代持待 M3 清退） |
| 真实 CF 装配 + 真机端到端（含步骤 ①②⑥⑦、三端真机互读） | 下次真机走查（部署者持 token；§7 五条） |
| GC cron 真实周期（SCHEDULER DO） | M3 前 |
| `@展示名` 直输的服务端复核口径（现按 `@<username>` 复核，展示名直输被过滤） | M3 服务端口径调整时一并做 |
| SESSIONS KV 绑定彻底移除（含 modules/chat/wrangler.jsonc 形状校验 + steps.ts 摘要面） | M3 清退 |
| chat 前端产物含 `dev-shim.html`（dev-only 页面随 assets 部署） | 走查观察项，建议 M2 收口时清理（低危：shim 只能签发未签名假令牌，被 worker 拒绝） |

**M2 关单条件（机制⑤）判定（#239 终验后）**：M2 名下 issue 已清零（#229/#234/#235/#230/#231/#239 全关）；本地可验证范围全链通过（§1 表 + §3.5）；剩余未证实 5 条（§7）全部为**真机/真云项**（缺设备/部署者 token，非代码缺陷）→ **满足本地收官条件，可关单 v0.3.0**；真机/真云走查作为独立验收活动由部署者执行（不阻塞 M2 代码收官，证据回填本文件）。

## 9. 验收资产

- 走查原始输出（红灯/dry-run/双端 live/停用/过期/375px）：`docs/audit/221-本地走查-2026-09-16.md`
- 截图（375px 与桌面）：`docs/audit/221-assets/221-01…05-*.png`
- **#234 复验原始输出**（mine/自读过滤/服务端兜底/DM/实时面探针/正对照）：`docs/audit/234-live复验-2026-09-16.md`
- **#234 复验截图**：`docs/audit/234-assets/234-01…05-*.png`（桌面 mine+回执、375px 消息流、DM 已读 ✓✓）
- **#239 终验原始输出**（实时上屏/竞态/实时回执/@提及/DM/自读过滤/375px，探针帧序与 API 复查）：`docs/audit/239-live终验-2026-09-16.md`
- **#239 终验截图**：`docs/audit/239-assets/239-01…08-*.png`（实时收到、实时回执递增、提及回填、DM 未读→✓✓、已读名单浮层、375px 消息流/DM）
- 相关测试（更新）：+`modules/chat/frontend/test/live-frames.test.ts`（#235 解析/竞态）、`mention-identity.test.ts`（#230）、`modules/chat/test/chat-profile-session.test.ts`（#231）、`chat-read-receipts.test.ts`（#229 服务端兜底）
- 复现配方（本地 live 走查）：audit 文档「环境配方」节（`.dev.vars`、`mint-token.mjs`、vite live 代理、辅助脚本全文）；#234 探针脚本全文见 audit 234 §E
- 相关测试：`modules/chat/test/chat-read-receipts.test.ts`、`chat-ws-renewal.test.ts`、`chat-messages.test.ts`、`modules/chat/frontend/test/read-receipts.test.ts`、`deploy/cloudflare/test/chat-*.test.ts`（**注：#235 的 live WS 入参解析无任何测试覆盖**）
