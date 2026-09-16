<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# modules/chat worker 搬运说明（M2 · issue #216）

## 上游与基准

- 上游：aozorae/Edgechat（v2.7.0，GPL-3.0-only）
- 搬运基准（钉死）：commit `29978c221ee3ae641ce0b9b97851656c00714a5d`（`29978c2 feat: support private groups in Telegram bridge`）
- 搬运方式：`cp` 逐字节复制，不手抄；除文件头追加两行出处注释外，搬入文件只在下文「接线点删除」所列位置做最小删除，其余内容与上游逐字节一致（已用 diff 逐文件验证）
- 每个搬入源码文件头部统一为：
  - `// SPDX-License-Identifier: GPL-3.0-only`
  - `// Source: aozorae/Edgechat@29978c2… <上游原相对路径>（GPL-3.0-only，裁剪版）`
- 上游源文件原有内容（含版权/许可声明）一律原样保留

## 保留清单（整文件搬运，共 59 个文件）

- `worker/src/api/`（9）：channels.js contacts.ts dm.js maintenance.ts messages.js upload.js user-blocks.ts user-profile.ts v1.js
- `worker/src/data/`（14）：channels.js channel-deletion.ts dm-provisioning.js dm-queries.js general-channel.js mentions.js messages.js pins.js replies.js site-settings.js unread.js uploaded-files.js user-blocks.ts users.js
- `worker/src/do/`（3）：ChannelRoom.js Scheduler.js UserInbox.js
- `worker/src/maintenance/`（3）：do-health.ts schema-contract.ts system-check.ts
- `worker/src/` 顶层（23）：attachment-metadata.js auth.js avatar-policy.js do-bridge.js encryption.js errors.js external-message-submission.js gc.js index.js message-deletion.js message-pinning.js message-submission.js middleware.js mobile-session.js realtime-tickets.js room-access.js session.js site-icon.js storage-statistics.js unread-projection.js user-status.js utils.js verified-identity.js
- `worker/src/` 测试（5）：auth.test.js user-status.test.js encryption.test.js message-encryption.test.js attachment-encryption-route.test.js
- `shared/`（2）：group-channel.ts user-profile.ts（从上游仓库根复制；worker 内 `../../shared/` 相对引用在 modules/chat/ 下解析为 `modules/chat/shared/`，与上游布局一致）

## 裁剪清单（整文件不搬）

- `src/integrations/telegram/` 全部（bridge.js avatar.js client.js parser.js 等）
- `src/api/telegram.js`、`src/api/admin.js`
- `src/data/telegram.js`、`src/data/registration-invites.js`
- `worker/migrations/` 整目录（上游 worker/migrations/ 23 个 migration 文件不搬，schema 由 `worker/schema-baseline.sql` 承载，见下；上游全量迁移清单共 24 个，含 1 个已退役迁移，其中 2 个为 Telegram 迁移）
- `worker/src/generated/schema-manifest.json`（上游由 `npm run schema:generate` 生成的维护自检清单；生成器依赖 sql.js 与 migration 校验和清单，均不在搬运范围。上游 `maintenance/system-check.ts` 引用该文件，但本裁剪已不再挂载维护路由，运行时图不包含该模块）
- `worker/repairs/`（上游运维修复脚本，不在保留清单，未搬）
- `worker/schema.sql` 原件不搬（被 schema-baseline.sql 取代）

## 接线点删除（逐条，对应任务 B–H）

1. **B · index.js**：
   - 删 import：`createUserWithRegistrationInvite`/`getAvailableRegistrationInvite`（data/registration-invites.js）、`registerAdminRoutes`（api/admin.js）、`registerMaintenanceRoutes`（api/maintenance.ts）、`registerTelegramAdminRoutes`/`registerTelegramPublicRoutes`（api/telegram.js）
   - 删调用：`registerTelegramPublicRoutes(app)`、`registerAdminRoutes(app)`、`registerMaintenanceRoutes(app)`、`registerTelegramAdminRoutes(app)`
   - 删路由块：`/api/register-links/:token` 与 `/api/register-links/:token/register` 两个 handler
   - 保留：`/api/auth/login`、authMiddleware、`/api/auth/session|logout|change-password`、`/api/site`、`/api/users`、`/api/bootstrap`、DO 导出（ChannelRoom/Scheduler/UserInbox）、`scheduled` handler、全部消息/频道/DM/上传/联系人/屏蔽/资料路由
   - `adminMiddleware` import 与 `app.use('/api/admin/*', adminMiddleware)` 保留（middleware.js 骨架不动；admin 路由已无挂载，该中间件不可达但 import 不悬空，#217 认证面将复用）
2. **C · do/ChannelRoom.js**：删 `forwardEdgeChatMessageToTelegram` 的 import 与 `runMessageProjections` 里的调用；`Promise.all([...])` 简化为直接 `waitUntil(projectUnreadMessage(...))`，行为等价（剩唯一 projection）
3. **D · data/messages.js**：`mapReplySender`、`mapMessage` 两处 `isTelegramExternal ? ... : ...` 简化为非 Telegram 分支（`external_sender_avatar_url || ""`），删 `isTelegramExternal` 局部变量；其余逻辑不动
4. **E · api/v1.js**：不动（mobile-session 认证面，归 #217 评估）
5. **F · storage-statistics.js**：删 `normalizedKey.startsWith("telegram/")` 分支（原返回 `system:telegram`），其余保留
6. **G · data/channel-deletion.ts**：注释措辞「置顶、同步事件和 Telegram 映射由外键级联」→「置顶、同步事件由外键级联」（纯注释，业务零变化）
7. **H · data/unread.js**：注释「计数语义与 Telegram 一致」→「与外部桥接一致」（纯注释，业务零变化）
8. **H · attachment-encryption-route.test.js**：删除末尾 telegram 附件下载测试块（objectKey `telegram/…`，验证的是已裁桥的下载路径）

## schema 归并

- `worker/schema-baseline.sql` = 上游 `worker/schema.sql` 终态 + 22 个非 Telegram migration 归并，基准 `29978c2`
- 相对上游 schema.sql 的差异仅两处：删 `telegram_bridge_config`、`telegram_mappings` 两表；删 `idx_telegram_mappings_channel` 索引
- 实测（node:sqlite 全量 exec 通过）：16 表、24 索引、16 触发器；种子含 `site_settings`（site_name=Edgechat、site_icon_url=''）与 general 频道种子触发器
- **为何不做升级链**：unself 无存量 Edgechat 实例，首次建库直接落基线；上游 `migrations/` 23 个文件不搬运，历史演进在上游仓库按 commit 可追溯。migration 目录不搬意味着不存在「已应用迁移文件」记账问题

## 已知裁剪影响

- **admin 面整体下线**：`registerAdminRoutes` 未挂载；但 DM/频道 API 内部的 `/api/admin/dms`、`/api/admin/channels*` 端点函数仍留在原文件（只删不改红线，路由不挂载即不可达）
- **typecheck 集成遗留**：worker 的 .ts 文件（contacts/user-blocks/user-profile/channel-deletion 等）为上游原样，在仓库 tsconfig 下会报类型错误；`test/*.ts`（并行 worker B 面）对 index 默认导出的调用假设与上游 `export default { fetch, scheduled }` 形状不一致。两者均不在本任务边界内，需 worker B/后续 issue 处理
- **storage-statistics.js 暂无调用方**：上游仅 `api/admin.js` 引用它（admin 存储统计入口已裁）；文件保留，供后续 upload 统计复用
- **maintenance API 不再暴露**：`registerMaintenanceRoutes` 调用删除（原挂 `/api/admin/maintenance`）；`maintenance/` 三个模块保留（do-health 仍被 ChannelRoom.js 引用，system-check/schema-contract 供后续复用）
- **注册邀请**：入口路由与数据层文件已裁；`registration_invites`/`registration_invite_uses` 表仍在基线 schema（保留上游终态结构，不裁业务表）
- **external 消息通路保留**：`external-message-submission.js` 与 ChannelRoom 的 `receiveExternalMessage` 是 verified internal 协议面（上游唯一生产方是 Telegram webhook），原样保留，归 #217 评估
- **消息外链头像**：external 发送者 avatarUrl 一律取 `external_sender_avatar_url`（`/api/integrations/telegram/avatar/…` 代理路径已随桥裁掉）
- **存储归类行为差异**：`telegram/` 前缀对象不再归 `system:telegram`，会落入 `system:unknown`（无存量数据，仅统计归类语义变化）

## #217 认证适配（unself 集成层）

### 本地认证面裁剪（对上游 worker 的删除清单）

- `index.js`：删 `POST /api/auth/login`、`GET /api/auth/session`、`POST /api/auth/logout`、`POST /api/auth/change-password` 四个路由块及 createSession/putSession/deleteSession/hashPassword/verifyPassword/updateCurrentDeviceSessionVersion/isUserDisabled/getUserByUsername 等 import；增 `GET /api/me`（返回内部数字 id + `core:<sub>` 用户名 + display_name）
- `api/v1.js`：删 `POST /api/v1/auth/login|refresh|logout`（移动端设备会话）与 `POST /api/v1/realtime/tickets`、`GET /api/v1/realtime/ws`（票券 WS 通道）；房间 sync/messages/read/uploads/legacy 代理全保留。JWT 直连 `GET /api/ws/:kind/:id`（`?token=`）取代票券
- **整文件删除（上游件删除，记录在案）**：`worker/src/mobile-session.js`（移动设备会话/刷新令牌）、`worker/src/realtime-tickets.js`（一次性 WS 票券）——两者唯一生产方就是上列被裁端点
- 上游残件保留：`auth.js`（密码哈希/会话 KV 读写）、`session.js`（validateSession）——调用点已全部裁撤，文件不动（上游件只删不改红线；测试工厂 createSeedUser 仍引用 hashPassword）。`SESSIONS` KV 绑定与两者仍留在 wrangler.jsonc（避免动部署装配面；后续清理归装配侧）

### 验签接线（core → chat）

- `worker/src/core-auth.js`（新增，unself 集成层）：`verifyAccessToken(env, token)` → `{ok, claims}|{ok:false,status,message}`。复用 `@unself/module-sdk` 的 `verifyModuleToken`（jose createLocalJWKSet + jwtVerify(audience) + contracts 解析，**不手搓**）；aud 常量 `AUDIENCE='chat'`（红灯验证点）；`CORE_JWKS_JSON` 空 → 503 `'jwks not provisioned'`（与 hello 口径一致）；任何验签失败 → 401 人话 `'请先登录'`（不回显 jose 细节）；`CORE_ISSUER` 非空时额外校验 iss（可选）
- token 形状（签发侧源码已核，基线 2ab19ef）：`services/core-api/src/token.ts` issueModuleToken——ES256 + kid（RFC7638 指纹），claims `iss='unself-core'` / `sub=<core users.id>` / `aud=<模块id>` / `iat` / `exp=iat+600`，JWKS 经 `GET /.well-known/jwks.json`。部署装配期由 deploy steps 注入 vars `CORE_JWKS_JSON`（wrangler.jsonc 已声明空默认值）

### JIT 建档

- `worker/src/jit-users.js`（新增）：`coreUsername = 'core:' + sub`（users.username UNIQUE 冲突即幂等锚点，与本地注册命名空间天然隔离）→ INSERT OR IGNORE + core_identities 映射行 → 反查 users 行；display_name 仅空行时回填 claims.name（不逐请求 UPDATE）；停用复查（is_disabled/disabled_until/deleted_at）→ 401 `'账号已停用'`
- `schema-baseline.sql` 尾部 #217 增补 `core_identities(issuer, sub, user_id UNIQUE)` 表（决策 #12 issuer+sub 映射的显式落库）；general 入席由既有 `add_new_user_to_general` 触发器兜底

### WS token 续期协议（决策 #51 定案 C + 按消息重验）

- socket meta 不再存 token 字符串：`{principal:{userId,isAdmin,claims}, room}`，claims 随 serializeAttachment 持久化（JSON 可序列化）
- 建连：verified 内部通道优先（HTTP 面 middleware 已验签+JIT，头带内部数字 id，行为不变）；否则 `?token=` JWT → verify → jit → authorizeRoom → 101
- 续期帧：客户端发 `{type:'token_refresh', token:<新token>}` → DO 当场验签+JIT+房间授权 → 原子换绑（connections+serializeAttachment）→ ack `{protocolVersion:1,type:'token_refreshed'}`；任一步失败 → `closeUnauthorizedSocket`（1008 'Unauthorized'）。**允许旧绑定已过期时刷新**（这正是续期场景）
- 按消息重验：每条业务帧先 `revalidateConnection`——claims.exp ≥ now + jit 停用复查 + authorizeRoom；任一不过 → 1008。上游「按消息重验 → policy violation 关闭」骨架原样保留，只把「验会话」换成「验 JWT 绑定」
- 定案理由：零附加有效窗口（宽限/双 token 都让旧 token 多活一段，与「短时效是主要吊销手段」冲突）；SDK onToken 钩子现成，协议只加一种控制帧。live 前端接线归 #225 后续波次

### 测试/脚本

- `test/chat-core-auth.test.ts`：正例（验签→JIT→API）+ 负例族（无 token/乱串/错签/错 aud/过期 → 401；缺 JWKS → 503）+ JIT 幂等/停用；真 ES256 keypair 手法抄 `modules/hello/test/hello.test.ts`
- `test/chat-ws-renewal.test.ts`：建连 101/ready/meta、token_refresh 换绑不断连、无效 refresh 1008、停用/过期下一帧 1008；`test/ws-stub.ts` 提供 WebSocketPair/Response(101) 最小运行时垫片（替运行时面，业务全走真类）
- `test/chat-messages.test.ts`：login() 助手换成 jose mint token（断言不变，username 变为 `core:<sub>` 形状）
- `scripts/mint-token.mjs`：dev 自测签发（生成/复用 keypair → 打印 CORE_JWKS_JSON 与 10 分钟 token），替代被裁的本地 dev 登录入口；keypair 缓存 `.mint-token-keys.json` 已 gitignore，dev-only 不进 worker bundle
- `package.json`：dependencies 增 `@unself/module-sdk: workspace:*`；devDependencies 增 `jose: ^6.1.0`（测试/脚本签名用）；仓库根 pnpm-lock.yaml 被动更新（#218 cd0051a 同款，PR 明示）

## 验收 grep 约定（自检 1）
`grep -rni "telegram|capacitor" modules/chat/` 的预期命中仅限三类说明性文字，无业务代码命中：
1. 本文件（MIGRATION-NOTES.md）：搬运/裁剪记录本身必然提及被裁对象
2. `worker/schema-baseline.sql` 头两行出处注释：说明基线相对上游删了哪些表
3. `test/chat-schema.test.ts`（并行 worker B 职责面）：该测试断言 telegram 残留表不存在，属验收断言而非桥实现

除此之外的 `worker/src/**`、`worker/schema-baseline.sql` 结构体、`shared/**` 中 telegram/capacitor 零命中。

## 逐字节验证

- 58 个未改文件：剥去 2 行文件头后与上游对应文件 `diff` 全部为空
- 6 个接线改动文件（index.js、ChannelRoom.js、messages.js、storage-statistics.js、channel-deletion.ts、unread.js）+ attachment-encryption-route.test.js：diff 仅含上表所列删除

## #220 已读回执（unself 集成层）

- **schema-baseline.sql** 尾部 #220 增补：`read_receipts(message_id, user_id, read_at)`，主键(message_id,user_id)=幂等锚点，`messages ON DELETE CASCADE`；与 `message_reads` 频道级游标并存不互改。chat 无升级链包袱（#216 定案），基线直改
- **worker/src/data/read-receipts.js**（新增）：recordReadReceipts（INSERT OR IGNORE + 批内去重 + 跨房消息过滤，回新增行 diff）/ listReadReceipts（每页一条 IN 查询不 N+1）/ countReachableRecipients（listRoomMemberIds 口径：成员∧未删∧active）
- **worker/src/api/messages.js**：POST /api/messages/read 扩展批量 `{kind, roomId, messageIds[]}`（≤200 413、批内去重、幂等；未入房 403；留旧 messageId 单值兼容）；DO 是唯一写者（落行+diff+广播），DO 不可达降级本地直写；GET /api/messages 每条消息富化 `readReceipts{count, readBy[], total}`——**分母=可达收件人（发件人恒已读不计）**（决策 #52）
- **worker/src/do-bridge.js / do/ChannelRoom.js**：内部路由 POST /receipts（verified internal，同 /client-action 形状）+ GET /receipts/snapshot（最新30条聚合兜底，json_object 键 userId/readAt 与前端帧同形）；实际新增>0 才聚合广播 `{protocolVersion:1, type:'read_receipts', messageId(批内最大), userId, readAt, messageIds[]}`；上游广播机制零改动（回执事件=新增）
- **前端**（自研件，非上游）：MessageBubble 回执标签（DM=已读✓✓/群聊=已读 n/m）、ReadReceipts 名单浮层（Teleport+Esc/遮罩/钮关闭）、chat-store readReceipts 真值+read_receipts 帧合并+recordVisibleRead 可见性上报（IntersectionObserver 批量）、session onTokenRenewed → store.refreshSocketToken（WS 控制帧换绑，决策 #51——**#225 遗留 live 接线在本 issue 补验**）
- **测试**：worker `test/chat-read-receipts.test.ts`（11 用例：上报/幂等零事件/403/413/口径/跨房/DO 帧形+兜底快照）；frontend `test/read-receipts.test.ts`（15 用例：标签/浮层/帧幂等/上报去重/live api 契约/续期接线）；红灯证据 M1–M5 见 /tmp/tasks/evidence-220-worker.md（M1/M3 亦录 PR 描述）
