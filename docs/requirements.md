# Unself 自托管协作平台需求汇总

> 状态：架构决策 v2（2026-09-06）
> 背景：Unself 面向自托管团队协作。官方优先提供 Cloudflare 一键部署，同时支持 Docker 和外部服务组合；本文件中的 unself.cn、Stalwart 与 Gitea 是团队参考部署，不是产品强制依赖。
>
> 产品不是 SaaS。一次安装对应部署者自己的独立实例，Unself 不承载中央租户、用户数据或组织配置。

## 0. 现状与约束

### 已有资产
| 资产 | 说明 |
|---|---|
| 邮箱系统 | Stalwart 0.16（新机器 23.94.152.101），域名 unself.cn（主）/ handywote.top（个人） |
| 代码托管 | Gitea 1.27（NAS），git.unself.cn，现有 9 名用户 |
| 反代 | openresty（新旧两台），80/443 已就绪 |
| 内网 | Tailscale 全网打通（3 VPS + NAS） |
| 团队规模 | ≤10 人，1 名管理员（handy） |

### 产品与参考部署的边界

- **产品能力**：任何团队可在自己的 Cloudflare 账户、Docker 环境或两者组合中部署独立实例；身份、邮件、日历、聊天、会议、存储都可按模块启停或替换。
- **官方首选**：Cloudflare 一键部署，自动创建或绑定所需的 Pages、Workers、D1、KV、R2 和 Durable Objects 资源。
- **Docker 角色**：替代部署方式，以及 TURN、SFU、录制和不适合 Workers 的可选组件运行环境。
- **本团队参考部署**：Stalwart、Gitea、openresty、Tailscale 和 unself.cn，作为官方示例与首个生产实例。

### 硬约束与默认原则

1. **自托管而非 SaaS**：每个部署者运行自己的独立实例，数据和组织配置不离开其账户/基础设施。
2. **Cloudflare 优先**：一键部署是官方首选；核心功能必须可由 Workers/Pages 等 Cloudflare 产品运行。
3. **可组合部署**：Docker 和外部服务用于扩展、替代部署或不适合 Workers 的能力，不能破坏核心模块的独立启停。
4. **开放身份**：标准 OIDC 是唯一登录协议，不要求使用特定邮局或邮箱域名。
5. **低运维**：默认模板让非专业运维也能完成部署和升级；复杂网络组件按需启用。
6. **大陆可用**：参考部署需要满足中国大陆团队的访问体验。

## 1. 身份与成员体系（P0）

- [ ] **唯一登录协议 = OIDC**：部署者填写自己的 OIDC Issuer、Client ID、scope 和 claim 映射；可使用 Stalwart、Keycloak、Authentik、Zitadel 等任意兼容提供方。
- [ ] 用户主键为 `instance_id + issuer + sub`，邮箱只用于显示和通知，不能作为不可变身份主键。
- [ ] 团队角色：管理员 / 用户 / 访客；管理员只管理当前这一套实例对应的一个团队，模块权限由实例配置和模块自身策略共同决定。
- [ ] 成员加入支持 OIDC 首次登录、邀请链接或管理员预授权。
- [ ] 模块身份：模块不接触外部 OIDC，只接受核心签发的模块 token（JWT、aud=模块、10 分钟、静默续期、postMessage 握手交付）；模块后端只验签。
- [ ] 模块 token 中的 sub 为核心内部稳定用户 id；`issuer + sub` 映射仅存于核心。
- [ ] 成员停用即时广播踢人事件，token 短时效作兑底上限；登出由壳清会话并广播，外部身份源 SLO 暂缓。
- [ ] 首个管理员通过一次性 setup token 产生，使用后立即失效封死。
- [ ] 邮箱开户、密码管理、应用专用密码和离职停用通过可选 Provisioning 适配器实现；支持 Stalwart API、SCIM 或 Webhook，但不是 OIDC 的职责。

## 2. 邮件（可选适配器）

- [x] 本团队 Stalwart 参考部署具备 SMTP、IMAP、DNS 与外发基础设施。
- [ ] 平台邮件能力使用通用 SMTP 适配器，支持欢迎信、通知和 Git 事件投递。
- [ ] Stalwart 适配器支持可选的开户、禁用、应用密码和限速管理。
- [ ] 未配置邮件时，平台仍可运行，通知默认使用站内通知。
- [ ] 邮局与 OIDC Provider 可以是同一个服务，也可以完全分离。

## 3. Git 集成（可选模块）

- [ ] 支持 Gitea、GitHub、GitLab Webhook 的签名校验和统一事件格式。
- [ ] 聊天模块启用时，事件可进入“Git 动态”频道；邮件模块启用时，可发送邮件通知。
- [ ] 本团队 Gitea 参考配置：审批注册、`@unself.cn` 邮件规则和 Stalwart SMTP。
- [ ] Git 服务不应成为核心登录或工作台可用性的单点依赖。

## 4. 可选协作模块（P1-P2）

每个模块都必须可独立启用、禁用、部署和升级。模块未启用时不得出现在统一壳边栏，也不得要求创建其专属云资源。

模块是自包含部署单元：默认以 iframe 装载在单域名路径 `/m/<模块id>/` 下，壳与模块之间只有 manifest、module-sdk 和 Core API 三条通道；模块内部实现（包括对 EdgeChat/MiroTalk 的大改）壳概不知情，第三方模块可在 manifest.entry 填独立域名。

### 4.1 IM 即时通讯（可选）
- [ ] 默认官方实现：EdgeChat（Cloudflare Workers + Durable Objects）。
- [ ] 单聊、群聊、文件、@ 提醒、消息持久化和历史检索。
- [ ] 逐条已读回执作为 EdgeChat 官方扩展。
- [ ] 通过 OIDC 接入，不依赖其原始本地账号体系。

### 4.2 日历（可选）
- [ ] 个人日程、共享日程和会议邀请。
- [ ] 通过 CalDAV/JMAP/iCalendar 适配器接入；Stalwart 是参考实现之一。
- [ ] 自建响应式日历前端，可与标准 CalDAV 客户端互通。

### 4.3 会议（可选）
- [ ] 默认官方实现：Cloudflare Worker + Durable Object 提供鉴权、房间状态和 WebSocket 信令。
- [ ] 浏览器通过 WebRTC 建立 P2P 音视频与屏幕共享，媒体不经过 Worker。
- [ ] 允许配置外部 STUN/TURN；SFU、录制和大规模会议为 Docker/外部服务扩展。
- [ ] 浏览器本地记录参会者音频；音频存档永不上云，可手动导出、不备份。
- [ ] 转写两档：普通会云转写（Web Speech），机密会由主持人强制完全本地（量化 Whisper）或不转写；成员可 opt-out，各自转写自己的音轨。
- [ ] 时间轴用会议 DO 房间时钟：入场领偏移、本地自打时间戳、散场只传纯文字片段，Worker 排序合并。
- [ ] 合并记录参会者可读、主持人独占写；个人片段参会者互见；未启用文档模块时记录保留在会议模块内。
- [ ] 配置 AI Provider 后经 SDK AI 能力（ai.complete()）生成摘要、行动项和纪要；文档模块启用时经核心代调（act claim）写入文档，参会者天然读、主持人写（记核心通用 ACL）。
- [ ] 录音、转写和 AI 处理会前明确提示；管理员可按实例策略禁用云转写通道。

### 4.4 文档与看板（可选）
- [ ] Markdown 文档协作、评论与基础权限。
- [ ] 看板视图管理任务，任务截止日期可同步到已配置的日历。
- [ ] 不需要重型多维表格引擎。

### 4.5 文件、通知与日报（可选）
- [ ] S3 兼容存储适配器，支持 R2、MinIO 和用户自备桶。
- [ ] 站内通知为基础能力；邮件通知仅在 SMTP 模块启用后可用。
- [ ] 日报/周报、评论与简单统计作为后续模块。

## 5. 非功能需求

| 项 | 要求 |
|---|---|
| 产品形态 | 自托管软件，一次部署对应一个独立实例；非中心化 SaaS |
| 首选部署 | Cloudflare 一键部署，部署到使用者自己的 Cloudflare 账户 |
| 替代与扩展 | Docker 可运行核心替代部署、TURN/SFU/录制及不适合 Workers 的组件 |
| 访问入口 | 每个实例使用自己的域名和 HTTPS |
| 身份 | 通用 OIDC；Stalwart、Keycloak、Authentik 等均可接入 |
| 模块 | 左侧导航由启用模块动态生成，模块可独立升级和停用 |
| 移动端 | 平台级要求：一切界面 mobile 可用（能看+轻操作）；审批=桌面管理页主入口+手机同页响应式。工作台壳双形态（桌面左栏/窄屏底部标签栏）；PWA 安装化在 M6 |
| 数据备份 | 部署者负责关键数据备份；官方提供 R2/S3/NAS 等示例 |
| 权限 | 管理员 / 用户 / 访客，另加模块级权限 |
| 视频会议 | P2P WebRTC 优先；Worker 只做信令；TURN/SFU 为可选外部扩展 |
| 文件存储 | S3 兼容，R2/MinIO/自备桶可配置 |
| 可维护性 | 一键部署、版本化配置、模块化升级和清晰的许可证边界 |

## 6. 已确认架构决策（2026-09-06）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 产品形态 | 自托管软件，不提供中央 SaaS 或多租户托管平台 |
| 2 | 首选部署 | Cloudflare 一键部署；代码与资源部署到使用者自己的 CF 账户 |
| 3 | Docker | 作为替代部署和扩展能力，不与 CF 主路径竞争 |
| 4 | 身份 | 登录能力核心内建：内置账号（用户名+密码）为默认；外部 OIDC 为可选增强；支持任意兼容身份源或支持 OIDC 的邮局；身份不是模块（2026-09-10 修订） |
| 5 | 模块 | 聊天、日历、文档、看板、会议、Git、邮件均可选；未启用则不显示、不部署 |
| 6 | 即时通讯 | EdgeChat 是官方 Cloudflare 模块，使用 Worker + Durable Objects；可在未来接入其他实现 |
| 7 | 会议 | Cloudflare Worker + DO 做信令，浏览器 WebRTC P2P 传媒体；TURN/SFU/录制作为外部扩展 |
| 8 | 日历与邮件 | CalDAV/iCalendar 与 SMTP 为通用协议；Stalwart 是官方参考适配器 |
| 9 | 代码组织 | 单一 monorepo 管理核心、模块、适配器和部署；第三方完整源码保持独立构建边界 |
| 10 | 许可证 | **核心 = AGPL-3.0**（防 SaaS 白嫖，威胁模型明确）；EdgeChat 衍生件遵守 GPL-3.0（独立 Worker）；重写的 EdgeChat 前端为自研归 AGPL；MiroTalk 衍生件遵守 AGPL-3.0；边界靠构建产物判定，LICENSE/NOTICE/components.yaml 落仓库；贡献用 DCO |
| 11 | 模块装载 | 模块为自包含部署单元；默认 iframe 装载器，第一方同域路径挂载，微前端不采用；契约不写死 iframe |
| 12 | 模块身份 | 核心统一身份（内置或 OIDC）并签发模块 token；模块只验 token，不接触身份源 |
| 13 | 域名 | 单域名路径制 `/m/<模块>/`；Workers Routes 与 openresty location 等价；第三方模块可用独立域名 entry |
| 14 | 数据归属 | 两个 D1：core（平台数据，物理独立）+ modules（全部模块业务数据，表前缀=模块id）；R2 统一适配层按前缀隔离；export/purge 为模块生命周期契约；模块一律经 SDK 存储接口访问，禁止跨模块查询与外键 |
| 15 | 部署编排 | 装配 = wrangler 幂等脚本读 `unself.config.jsonc`，只在部署时执行，实例不持 CF 凭证；一键 = Deploy Button + Workers Builds；已部署模块启停 = 注册表开关 + token 门禁，秒级免部署；Docker 读同一份配置 |
| 16 | M0 技术栈 | TypeScript + Hono + Vue 3 + Vite + Tailwind + zod + jose + pnpm workspaces + Vitest；M0 = hello 模块七步验收剧本 |
| 17 | 会议记录 | 音频存档永不上云；转写两档（云/机密强制本地），主持人选定、成员可 opt-out；房间时钟统一时间轴，散场只传纯文字由 Worker 合并；核心代调 act claim + 通用 ACL（参会者读、主持人写）；AI 纪要经 SDK 能力；个人片段参会者互见 |
| 18 | 前端约定 | 设计令牌单一来源（tokens.css + Tailwind @theme，禁裸值）；组件查找序 beUI→shadcn 生态→手写（beUI 动效参数照抄移植 Vue）；基元内聚住 packages/ui；图标只用 Lucide（manifest 存图标名，拒绝 emoji）；中文写死、亮色单主题、系统字体 |
| 19 | 手机原则 | 平台级要求：一切界面 mobile 可用 = 能看 + 轻操作；重编辑/重管理允许桌面增强（按操作深度分不按功能分）；工作台壳双形态：桌面左栏 / 窄屏底部标签栏（同一 nav 数据）；PWA 安装化在 M6 |
| 20 | 身份与门户 | 内置账号为默认登录（密码表单 + SSO 按钮并存，按实例配置显隐）；已有 OIDC 账号首登自动建档复用（JIT，核心只存 issuer+sub 映射）；内置用户密码哈希存 core（2026-09-10 修订） |
| 21 | setup 动线 | 仅部署输出的一次性链接可配置；激活即成管理员并直接进工作台；已激活后 /setup 访问一律重定向，页面不复存在 |
| 22 | 可观测性 | 错误三层透传：成员只见人话+request id；管理员登录态可展开技术详情；服务端 wrangler tail + audit_log，request id 串联排查 |
| 23 | 邮箱可选 | 身份轴与邮件轴正交；邮件轴关闭时批准只翻状态（无开户无激活邮件），内置模式批准即激活；实例特定值（域名/发件地址）一律部署配置（2026-09-10 修订） |
| 24 | 邀请激活 | 邀请链接一次性/限期（默认 7 天）；批准 → 开户（随机初密）→ 激活链接发个人邮箱（一次性令牌+邮箱所有权双证）；不经管理员转交；内置模式下无激活邮件链——注册时设密码，批准即激活（2026-09-10 修订） |
| 25 | 账号移除 | 禁用 = 摘 authenticate 权限位（数据保留、可逆）；删除只在链路 6 完整版（导出后可选）出现 |
| 26 | 通知承载 | 通知类型表（type/文案模板/渠道位），类型是数据不是代码；模块经 SDK 触发为后续扩展路 |
| 27 | 入职门型 | 邀请制唯一入口：一次性+限期链接（默认 7 天，1-365 可调）；批量门（限次限时）为扩展位；永久链接与开放注册不做 |
| 28 | 双门语义 | 邀请链接管「谁能填表」，审批管「谁能进门」；注册表单（内置模式含用户名+密码）入库即 pending，批准即 active |
| 29 | 密码两用途 | 登录密码与邮箱密码是两个密码；合一只在 Stalwart 兼任 IdP 时巧合成立，非产品承诺；忘记密码 = 管理员手动重置（无邮件实例唯一恢复路径） |
| 30 | 用户名唯一性 | 注册时软校验（users+invites 双表查重即时反馈）；批准时硬校验（撞名走可恢复冲突：invite 留 pending + 人话提示） |
| 31 | 模块三分法 | 功能模块（原生 Worker）/ 适配器（包一层外部系统）/ 伴生服务（整台外部服务只做配置接线）；开发、部署、信任边界各异 |
| 32 | 官方改编纪律 | fork 只为省时间；默认不跟上游、看情况选择性吸收；继承上游许可证；改造按 L0-L3 适配光谱（官方功能模块走 L3 深度重写）；第三方 DX（sdk 文档/脚手架）是产品面 |

## 7. 第一性原理技术评估（初版）

### 架构原则
1. **一实例一团队**：每个团队部署并管理自己的实例；管理员只管理该实例对应的一个团队，不实现团队切换或 Unself 中央租户控制面。
2. **Cloudflare first**：统一壳、模块注册、Webhook、EdgeChat 和 P2P 会议信令优先运行在 Pages/Workers/Durable Objects。
3. **模块优先于产品套装**：模块有 manifest、依赖、路由、权限和部署目标；未启用即不显示、不创建专属资源。
4. **标准协议优先**：OIDC、SMTP、CalDAV/iCalendar、S3、Webhook 是外部服务边界；不把 Stalwart 写死为平台基础。
5. **实时能力可运行在 CF**：WebSocket + Durable Objects 是聊天和会议小型信令室的默认实现；不把实时能力预设为 VPS 常驻进程。
6. **P2P 媒体与信令分离**：Worker 承载会议鉴权、房间与信令，WebRTC 直接传媒体；TURN/SFU/录制按需放入 Docker 或外部基础设施。
7. **许可证按代码和构建产物隔离**：不通过目录名称假设许可证隔离，必须保留独立依赖、构建和服务边界。
8. **模块契约三通道**：壳与模块之间只有 manifest、module-sdk、Core API；模块默认 iframe 装载于 `/m/<模块id>/`，第一方同域同规，第三方可换独立域名 entry，契约不变；安全靠短时 token 验签，不靠 origin 隔离。
9. **数据边界靠契约不靠物理**：core 库独立护住平台数据；模块业务数据共居 modules 库，表前缀隔离，SDK 收口访问；模块必须实现 export/purge 生命周期接口。
10. **装配与启停分离**：装配只在部署时由 wrangler 幂等脚本执行，运行时进程不持有 Cloudflare 凭证；已部署模块的启停是注册表开关，秒级生效，免重部署。
11. **跨模块协作走核心**：模块互通只经核心代调（act claim 双主体）；资源级权限记核心通用 ACL；AI、存储等基础设施能力由核心配置、SDK 供给。

### 技术选型与复用调研（v2：二次开发缝合路线）

> 用户决策：不是部署现成产品，而是**二次开发把模块组合成一套精简产品**。

| 模块 | 官方默认实现 | 可替换/外部实现 | 二次开发重点 |
|---|---|---|---|
| 统一壳 | Vue3/React 单页壳，CF Pages/Workers | Docker 静态/Node 部署 | OIDC 会话、动态导航、模块加载、通知中心 |
| 身份 | 通用 OIDC | Stalwart、Keycloak、Authentik 等 | claim 映射、团队角色、模块权限 |
| IM | EdgeChat，CF Workers + DO + D1 + KV + R2 | 后续聊天适配器 | OIDC、逐条已读、模块 manifest |
| 日历 | CalDAV/iCalendar 适配器 | Stalwart、Nextcloud、其他 CalDAV | 响应式前端、会议/任务联动 |
| 看板/任务 | 自研轻量模块 | 外部任务系统适配器 | 看板和日历联动 |
| Markdown 文档 | 自研模块 + Milkdown/Tiptap | 外部文档系统适配器 | 内容、评论、权限 |
| 会议 | CF Worker + DO WebRTC 信令 | MiroTalk、其他信令服务 | 房间权限、信令协议、日历联动、录音/转写/纪要输出 |
| 文件 | S3 兼容适配层 | R2、MinIO、用户自备桶 | 上传授权和对象引用 |
| 邮件 | SMTP 适配器 | Stalwart、其他 SMTP | 通知、可选开户/停用适配器 |
| Git 动态 | CF Webhook Worker | Gitea、GitHub、GitLab | 事件规范化和模块投递 |

### EdgeChat 能力盘点（已读源码）
- ✅ 实时：Durable Objects WebSocket Hibernation，适合作为 Cloudflare 首选聊天模块。
- ✅ 群聊/私聊/语音消息/文件/头像/历史分页/@提醒/封禁。
- ✅ 文件存 R2，可通过存储适配层扩展到兼容对象存储。
- ✅ 管理后台、邀请和用户管理能力。
- ⚠️ 已读未读只有频道级游标，无逐条“已读 x/y”回执，需二次开发。
- ⚠️ 原生认证是本地账号体系，需接入通用 OIDC。
- ⚠️ 包含或修改其代码的模块必须独立遵守 GPL；未使用聊天模块的实例不部署其资源。

### 部署拓扑（Cloudflare 首选，单域名）
```
team.example.com（部署者自己的 Cloudflare 账户）
 ├─ /              → Shell + Core API / Module Registry（Workers）
 ├─ /m/chat/*      → 魔改 EdgeChat（可选：Workers + DO）
 ├─ /m/meet/*      → P2P 信令（可选：Worker + DO）
 ├─ /m/<其他>/*    → 其余第一方模块，按路径挂载，未启用不部署
 └─ 附件           → 可选 R2/S3/MinIO

外部可选服务（独立域名，不属于实例）：日历 CalDAV、邮件 SMTP/邮局
Docker / 外部扩展：TURN、SFU、录制、MiroTalk、完全私有化部署
 openresty 按 location 分发，与 Workers Routes 等价
```

### 本团队参考部署
- Stalwart 同时提供 OIDC、SMTP 和 CalDAV；这是官方示例，不是产品要求。
- Gitea 通过 Git 适配器发送 Webhook；聊天和邮件模块是否消费事件由当前实例配置决定。
- openresty、Tailscale 和 NAS 备份属于本团队运维方案，不进入 Unself 核心依赖。

## 8. 下一步

1. M0 垂直切片，按七步验收剧本交付：`contracts` → `module-sdk` → `core-api` → `shell` → `modules/hello` → `deploy/cloudflare` 幂等脚本。
2. 七步剧本：部署出 setup 链接 → 首个管理员登录 → 动态边栏出现 hello → iframe 握手拿模块 token → 后端 JWKS 验签并经 SDK 读写前缀表 → 启停秒级生效 → 移除模块重部署后路由消失。
3. M1 起按里程碑推进：通知中心、Docker 等价部署，然后 EdgeChat 模块与逐条已读回执。
