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
- **storage-statistics.js 暂无调用方**：上游仅 `api/admin.js` 引用它（admin 存储统计入口已裁）；文件保留，供后续 upload 统计复用
- **maintenance API 不再暴露**：`registerMaintenanceRoutes` 调用删除（原挂 `/api/admin/maintenance`）；`maintenance/` 三个模块保留（do-health 仍被 ChannelRoom.js 引用，system-check/schema-contract 供后续复用）
- **注册邀请**：入口路由与数据层文件已裁；`registration_invites`/`registration_invite_uses` 表仍在基线 schema（保留上游终态结构，不裁业务表）
- **external 消息通路保留**：`external-message-submission.js` 与 ChannelRoom 的 `receiveExternalMessage` 是 verified internal 协议面（上游唯一生产方是 Telegram webhook），原样保留，归 #217 评估
- **消息外链头像**：external 发送者 avatarUrl 一律取 `external_sender_avatar_url`（`/api/integrations/telegram/avatar/…` 代理路径已随桥裁掉）
- **存储归类行为差异**：`telegram/` 前缀对象不再归 `system:telegram`，会落入 `system:unknown`（无存量数据，仅统计归类语义变化）
- **typecheck 集成遗留**：worker 的 .ts 文件（contacts/user-blocks/user-profile/channel-deletion 等）为上游原样，在仓库 tsconfig 下会报类型错误；`test/*.ts`（并行 worker B 面）对 index 默认导出的调用假设与上游 `export default { fetch, scheduled }` 形状不一致。两者均不在本任务边界内，需 worker B/后续 issue 处理

## 验收 grep 约定（自检 1）

`grep -rni "telegram|capacitor" modules/chat/` 的预期命中仅限三类说明性文字，无业务代码命中：
1. 本文件（MIGRATION-NOTES.md）：搬运/裁剪记录本身必然提及被裁对象
2. `worker/schema-baseline.sql` 头两行出处注释：说明基线相对上游删了哪些表
3. `test/chat-schema.test.ts`（并行 worker B 职责面）：该测试断言 telegram 残留表不存在，属验收断言而非桥实现

除此之外的 `worker/src/**`、`worker/schema-baseline.sql` 结构体、`shared/**` 中 telegram/capacitor 零命中。

## 逐字节验证

- 58 个未改文件：剥去 2 行文件头后与上游对应文件 `diff` 全部为空
- 6 个接线改动文件（index.js、ChannelRoom.js、messages.js、storage-statistics.js、channel-deletion.ts、unread.js）+ attachment-encryption-route.test.js：diff 仅含上表所列删除
