# 产品设计文档：Unself 团队协作平台（缝合方案）

> 版本：v1（2026-09-06）· 角色：PM 视角全量设计
> 一句话定位：**以 unself.cn 邮箱为唯一身份的、自托管、可二次开发的轻量飞书替代品**

---

## 1. 产品是什么（做完之后的样子）

一个团队日常只需要一个入口的协作平台：

```
┌─────────────────────────────────────────────────────┐
│  https://team.unself.cn   （统一壳，飞书式左侧导航）    │
│                                                       │
│   📬 邮件     💬 消息     📅 日历     📋 看板/文档     │
│   📹 会议     ⚙️ 管理（仅管理员可见）                  │
│                                                       │
│   [左侧] 模块导航   [中间] 内容区   [右侧] 详情/日程     │
└─────────────────────────────────────────────────────┘
```

**团队成员的日常是**：

- 早上打开一个网址，看到昨晚的消息、今日日程、未读邮件摘要
- 点"消息"，像飞书一样聊天，发出去的消息能看到"已读 3/5"
- 群里 @ 人开会，顺手点"创建会议"→ 选时间/参会人 → 所有人日历上出现日程，收到确认提醒
- 会议时间到了，点日程里的"加入会议"→ 浏览器直接 P2P 视频（流量不过服务器）
- 项目进度用看板拖卡片，卡片设截止日期 → 自动出现在成员日历上
- 写文档就开一个 md 页面，@ 同事评论
- Gitea 上的仓库动态、issue 通知，进自己的邮箱 + 消息里的"机器人"频道
- 新成员入职：对方自己填申请 → 管理员点"同意" → 邮箱自动开好 → 拿着邮箱注册 Gitea

**管理员的日常是**：审批入队申请、冻结离职账号、看发送限额仪表盘，其他时候不用管服务器。

## 2. 角色与权限（三层）

| 角色 | 谁 | 权限 |
|---|---|---|
| 管理员 | handy（+指定 1-2 人） | 审批注册、开/停账号、发信不限量、看所有群、配置系统 |
| 用户 | 正式成员 | 全套功能：邮件/消息/日历/看板/文档/会议；外发信限速（如 50 封/小时） |
| 访客 | 外部协作者 | 只读或受邀参与特定群/看板；无邮箱账号（纯受限账号）；不能外发 |

**身份唯一性**：所有人（管理员/用户）= 一个 `xxx@unself.cn` 邮箱账号 = 登录所有模块的唯一凭证。访客是"外部受限账号"，不计入邮箱。

## 3. 需求 → 模块 → 复用/自研 对照表

| # | 你的原始需求 | 对应模块 | 底座 | 我们要做的二次开发 |
|---|---|---|---|---|
| 1 | 自助注册 + 审批后开邮箱 | 门户/审批 | 边缘 Worker + Stalwart API | 申请页、审批页、开号逻辑、通知 |
| 2 | 邮箱账号 = 统一身份 | 身份层 | Stalwart（邮件+OIDC Provider） | 各模块接 OIDC 登录 |
| 3 | 消息 + 已读未读 + 服务端推送 | IM | fork EdgeChat（CF DO 实时层） | 逐条已读回执、邮箱身份接入、UI 融入统一壳 |
| 4 | 日历/会议邀请/行业标准暴露 | 日历 | Stalwart CalDAV（零后端开发） | 日历前端界面、会议 UI |
| 5 | 看板 + md 文档 + 联动日历 | 协作 | 前端库（看板组件 + Milkdown） | 自研轻后端存 JSON/文本文档 |
| 6 | P2P 视频会议，流量不落服务器 | 会议 | MiroTalk P2P（信令） | 嵌入统一壳、与日历联动 |
| 7 | 文件存用户自备 S3 桶，可配置 | 存储层 | S3 适配层（R2/MinIO 可配置） | 统一上传接口 |
| 8 | Gitea 注册审批 + 通知内部投递 | Gitea 集成 | Gitea 自身配置 | webhook → 消息机器人频道 |
| 9 | 发信限速 + 白名单 | 邮件风控 | Stalwart Throttle/Quota | 配置 + 管理界面 |
| 10 | 日志/日报 | 日报 | 自研轻模块 | 提交/评论/统计 |
| 11 | 移动端可用 | 壳的移动适配 | PWA 或 EdgeChat 自带 Android 壳 | 统一壳 PWA 化 |

## 4. 核心端到端链路（这是"缝"的关键）

### 链路 1：新人入职（注册 → 审批 → 开号 → Gitea）

```
① 新人访问 team.unself.cn/signup
    填：想要的用户名 + 自设密码
② 申请写入边缘 Worker 的 D1 表（status=pending）
③ 管理员收到通知（IM 机器人频道 + 邮件）
④ 管理员在审批页点"同意"
     → Worker 调 Stalwart API：创建 xxx@unself.cn + 分配"用户"角色
     → 状态变 approved，发欢迎邮件到新邮箱
⑤ 新人登录（OIDC 走 Stalwart）→ 进统一壳，全部模块可见
⑥ 新人拿邮箱注册 Gitea（Gitea 强制 @unself.cn + 管理员确认）
     → Gitea 邮件走 noreply@unself.cn 内部投递
     → Gitea webhook → IM"Git 动态"机器人频道
```

### 链路 2：一条消息的"已读回执"（二次开发核心）

```
① A 在群聊发消息
② EdgeChat DO 广播消息到在线成员的 WebSocket
③ 每个客户端"看到"该消息时上报已读（前端可见性检测触发）
④ DO 写 read_receipts 表（message_id × user_id）
⑤ 推送"已读状态变更"事件 → 所有成员 UI 更新
   "已读 3/5"（飞书式逐条回执）
⑥ 离线成员上线后补拉历史消息 + 回执状态
```

> 现状：EdgeChat 有 `message_reads` 表（频道级游标，做未读计数）。
> 增量：加一张逐条回执表 + 一个上报接口 + 一条推送事件 + UI 组件。

### 链路 3：创建会议（日历 → 邀请 → P2P 视频）

```
① A 在"消息"里点"创建会议"，填时间/参会人
② 日历模块调 Stalwart CalDAV API 写事件（含参会者）
③ Stalwart 自动发会议邀请邮件（calendarSchedulingSend 已有）
④ B/C 在日历上看到日程，点"接受/拒绝"
⑤ 会议时间到 → 日程卡出现"加入会议"
⑥ 点 → 壳内嵌 MiroTalk P2P 房间（房间号=事件 ID）
⑦ 音视频流量 A↔B↔C 直连，服务器只跑信令（几 KB 流量）
⑧ 外部访客可用 CalDAV 标准协议订阅日历（预留接口）
```

### 链路 4：文件/附件（不占自家存储）

```
① 任何模块上传文件 → 统一走存储适配层
② 适配层按配置写入目标（默认：管理员配置的 R2/MinIO 桶）
③ 返回引用 URL，消息/文档/头像存引用
④ 换存储后端 = 改一个配置项（S3 端点/桶/密钥）
⑤ 大附件流量从 S3/CDN 走，不经过自家 VPS
```

### 链路 5：Gitea 联动（通知内部化）

```
① 仓库 push / issue / PR 事件
② Gitea webhook → 边缘 Worker（或 IM 机器人服务）
③ 格式化 → 发到 IM"Git 动态"频道（带跳转链接）
④ 邮件类通知（注册验证、合并通知）→ noreply@unself.cn
   → 收件人 @unself.cn → Stalwart 本地投递（零外域流量）
```

### 链路 6：离职处理

```
① 管理员在管理页点"停用账号"
② Worker 调 Stalwart：禁用账号 + 吊销应用密码
③ IM/日历/看板各模块按 OIDC 身份同步失效
④ 可选：数据归档到成员自备 S3
```

## 5. 缝合架构图（技术视图）

```
┌────────────────────────────────────────────────────┐
│          统一壳（自研 Vue3 单页，PWA）                │
│   模块路由 + 左侧导航 + 统一登录态 + 通知中心           │
└──────┬──────────┬──────────┬──────────┬────────────┘
       │          │          │          │
   ① 身份层    ② IM       ③ 日历     ④ 协作/会议
   Stalwart   EdgeChat    Stalwart   看板+文档+MiroTalk
   (OIDC)     (CF DO 实时) (CalDAV)   (自研轻后端)
       │          │          │          │
       └──────────┴──────────┴──────────┘
                    │
              ⑤ 存储适配层（S3 兼容，R2/MinIO 可配置）
              ⑥ 边缘 Worker（门户/审批/webhook/通知）
              ⑦ 邮件投递（Stalwart 本地/外发限速）
```

## 6. 代码组织：monorepo（用户拍板，2026-09-06）

**决策理由**（用户）：改动集中；本地开发不用跨 repo 跳转；跨模块复合修改可单 PR review（对人和 AI 都友好）。

```
team-suite/
├── apps/
│   ├── chat/            # EdgeChat fork（git subtree 同步上游）
│   ├── shell/           # 统一壳（Vue3 + Vite）
│   ├── calendar/        # 日历前端
│   ├── portal/          # 注册/审批 Worker
│   ├── docs/            # md 文档
│   ├── board/           # 看板
│   └── meet/            # 会议（MiroTalk fork：嵌入 + 本地录制补丁）
├── packages/            # 共享库
│   ├── ui/              # 设计系统组件库（Vue3）
│   ├── storage-adapter/ # S3 兼容适配层（R2/MinIO/TG-S3/自备桶）
│   ├── mcp-tools/       # 工具定义层（一份代码两个出口：/mcp + WebMCP）
│   └── types/           # 共享 TS 类型
├── infra/               # docker-compose、openresty、Stalwart 配置
└── .github/workflows/   # CI/CD：按变更路径只构建对应 app
```

**工具链**：pnpm workspaces + Turborepo（任务编排）；CI 按路径过滤，只构建/部署变更的 app。

**clone 体积担忧的解法**：
1. `git clone --depth 1`（浅克隆，日常开发够用）
2. 上游同步用 **git subtree**（EdgeChat/MiroTalk 作为 subtree 并入，`git subtree pull` 拉新版本，改动在自家树上正常 commit）
3. CI 路径过滤：改 chat 只跑 chat 的流水线

**许可证一致**：整个 monorepo 以 GPL-3.0 发布（EdgeChat GPL-3.0 + MiroTalk AGPL-3.0 subtree 共存，满足开源诉求）。

## 7. 部署拓扑

```
unself.cn（DNSPod）
 ├─ team.unself.cn   → 统一壳（CDN/静态托管或 CF Pages）
 ├─ chat.unself.cn   → EdgeChat Worker（CF，fork 后部署）
 ├─ mail.unself.cn   → Stalwart（新 VPS，邮件+日历+OIDC）
 ├─ api.unself.cn    → 边缘 Worker（门户/审批/webhook）
 ├─ meet.unself.cn   → MiroTalk 信令（轻量容器或边缘）
 └─ 附件             → 用户自备 S3 桶（可配置）
handywote.top（CF 账户）→ 备用/灰度入口，大陆访问兜底
```

## 8. 里程碑

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **M0（本阶段）** | 门户/审批 + Gitea 集成 + 成员迁移 | 新人申请→你同意→邮箱开通全自动；Gitea 通知全部内部投递 |
| **M1** | EdgeChat fork 部署 + 接邮箱身份 | 用 unself.cn 邮箱登录聊天；原版功能可用 |
| **M2** | 逐条已读回执 | 每条消息显示"已读 x/y"，离线补拉正确 |
| **M3** | 统一壳 v1：导航 + 消息 + 日历 | 一个入口切模块，日历会议邀请全链路 |
| **M4** | 看板/文档 + 日历联动 | 看板卡片截止日期出现在日历 |
| **M5** | 会议 P2P + 文件适配层 | 日程一键入会；上传走自备 S3 |
| **M6** | 日报 + 管理仪表盘 + 移动端打磨 | 全套可用，飞书正式退役 |

## 9. 风险与决策点

| 风险/决策 | 现状 | 建议 |
|---|---|---|
| EdgeChat 锁 CF（Durable Objects） | 已确认接受 | 大陆访问用 handywote.top 反代兜底 |
| EdgeChat 是 GPL-3.0 | 内部使用无碍 | 若不对外分发闭源产品则无需开源 |
| 已读回执需要改 DO 代码 | 有 message_reads 地基 | M2 单独排期，先跑通原版再改 |
| 视频 P2P 的 NAT 穿透 | 大多数家庭/公司网络可直连 | 极端情况配 TURN（轻量流量） |
| Stalwart OIDC 当身份源 | 能力已有（OidcProvider 对象） | M1 阶段实测 |
| 统一壳工作量 | 自研最大的一块 | 分模块渐进：先壳+消息+日历，其余逐个嵌 |

## 10. CF 免费层容量测算（10 人团队，2026 年官方数据）

> 注：CF 额度按**账户**计，不按成员。团队共用一个 CF 账户，成员只是应用内的用户 → **额度天然共享，无需“合并”**。

| 资源 | 免费层 | 10 人团队估算 | 结论 |
|---|---|---|---|
| Workers 请求 | 100K/天 | 聊天+门户 ~2-5K/天 | ✅ 用不到 5% |
| Durable Objects 请求 | 100K/天 | WS 连接 + 消息事件 ~1-3K/天 | ✅ 余量极大 |
| DO 时长 | 13,000 GB-s/天，Hibernation 不计量 | 几乎为 0 | ✅ |
| DO SQL 读 | 50M 行/天 | 分页拉历史 ~数十万行 | ✅ |
| DO SQL 写 | 100K 行/天 | 消息+回执 ~数千行 | ✅ |
| D1（门户/审批） | 5GB 存储，读 5M 行/天，写 100K 行/天 | 申请表单量极小 | ✅ |
| KV | 读 100K/天，写 1K/天，1GB | 会话存储 ~几十次/天 | ✅ |
| R2 文件 | **10GB 存储**，A 类 1M/月，B 类 10M/月，**出流量免费** | 10 人附件，起步期 1-2GB | ✅ 存储满后可自备桶 |
| Workers AI | **10K neurons/天** | 小模型助手对话约几十~上百轮/天 | ⚠️ 最紧的一项 |
| Pages 静态托管 | 无限制 | 统一壳前端 | ✅ |

**结论**：除 AI 外全部轻松覆盖，10 人团队基本零成本。两个升级触发点：
1. AI 用量超 10K neurons/天 → Workers Paid $5/月起，超出按 $0.011/千 neurons 计费（单次对话约几分钱）
2. R2 存满 10GB → 切换用户自备 S3 桶（存储适配层本来就支持）

## 11. AI 接入能力调研

### 10.1 两种协议：WebMCP vs 经典 MCP（关键区分）

| | WebMCP（EdgeChat 已接入） | 经典 MCP（本地 agent 主流） |
|---|---|---|
| 形态 | 页面在 ChatGPT 桌面版内置浏览器里打开时，通过 `document.modelContext.registerTool` 注册站点工具 | 独立服务进程（stdio/HTTP/SSE），agent 客户端主动连接 |
| 支持方 | OpenAI Codex/ChatGPT Work（实验标准）；社区桥接 `chgold/webmcp-client` 可接 Claude Desktop | Claude Desktop、Cursor、Copilot、自定义本地 agent 等全部支持 |
| EdgeChat 现状 | ✅ 已实现，注册 5 个工具：`edgechat.login / list_channels / read_messages / send_message / open_dm`（frontend/src/webmcp.ts，261 行） | ❌ 无现成 MCP server，也无 CLI（源码确认：仅 webmcp.ts + Telegram 桥） |

### 10.2 本地 agent 接入方案（基于源码调研）

EdgeChat 有完整 REST API（`/api/auth/login`、`/api/messages`、`/api/messages/read`、`/api/ws/...` 实时票券等），**写一个 200 行左右的 MCP server 包装这些端点即可让任意本地 agent 读写聊天**。

| 接入方式 | 工作量 | 适用 |
|---|---|---|
| 用现成 WebMCP（ChatGPT/Codex 浏览器） | 零 | 你在 ChatGPT 桌面版里操作聊天 |
| 社区桥接（webmcp-client）接 Claude Desktop | 低 | 用 Claude Desktop |
| **自建 MCP server（包装 EdgeChat REST API）** | 小（~200 行） | 任意本地 agent（Claude/Cursor/自写 agent/手机端 agent） |
| **统一平台 MCP server（聊天+日历+邮件+看板）** | 中（一个服务全模块） | 终极形态：本地 agent 像管理员一样操作整个平台 |

### 10.3 Workers AI 平台推理（另一件事）

| 能力 | CF 方案 | 说明 |
|---|---|---|
| 对话助手（IM 机器人） | Workers AI（Llama/DeepSeek-R1-Distill 等） | 边缘推理，免费 10K neurons/天，超了按量几分钱 |
| 文档/消息检索问答（RAG） | Workers AI 嵌入 + Vectorize（向量库） | 对自家 md 文档/消息做知识库 |
| 会议纪要/语音转写 | Workers AI Whisper | 录音→文字→摘要 |
| 外部模型接入 | Worker 内直连 OpenAI/DeepSeek 等 API | 本地模型不够时做路由 |

**建议**：
- 本地 agent 接入：优先用 EdgeChat 现成 WebMCP（零成本）；需要 Claude/Cursor 等时再写 MCP server 包装层；统一平台 MCP 放 M5 之后
- 平台内 AI：首版两个最小落地——①IM 机器人（@AI 问答）②会议录音转写


## 12. 与飞书的差异（明说，避免期待错位）

| 飞书有 | 我们 | 备注 |
|---|---|---|
| 云文档（富文本协同） | md 文档 | 够用但非富文本 |
| 多维表格（Bitable） | 看板 + 日历联动 | 轻量替代 |
| 视频会议（SFU，百人） | P2P（建议 ≤6 人） | 小团队场景 |
| 审批流/考勤等 HR 模块 | 无 | 自建按需 |
| 移动端原生 App | PWA + Android 壳 | 体验接近但不推送后台通知（安卓壳除外） |
