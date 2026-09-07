# 产品设计文档：Unself 可插拔自托管协作平台

> 版本：v2（2026-09-06）· 角色：PM 视角全量设计
> 一句话定位：**以 Cloudflare 一键部署为首选、支持 Docker 和外部服务组合的可插拔自托管协作平台**
>
> Unself 不是 SaaS，不提供中心化租户或统一托管服务。每个团队在自己的 Cloudflare 账户、服务器或私有基础设施中部署一套独立实例，并自行选择身份、邮件、日历、存储、聊天和会议模块。

---

## 1. 产品是什么（做完之后的样子）

一个团队部署完成后，只需要一个入口：

```text
https://team.example.com
```

统一壳根据管理员启用的模块动态生成左侧导航：

```text
┌─────────────────────────────────────────────────────┐
│  https://team.example.com  （自托管工作台）             │
│                                                       │
│   工作台   消息   日历   看板   文档   会议   管理       │
│                                                       │
│   以上菜单只显示已启用的模块。EdgeChat 未启用时不显示消息。│
│   [左侧] 模块导航   [中间] 当前模块   [右侧] 详情/通知    │
└─────────────────────────────────────────────────────┘
```

每次部署对应一个独立团队，不存在 Unself 中央 SaaS 租户、租户切换或多团队管理。模块可以来自 Cloudflare Worker、Docker 服务或外部系统，但对用户呈现为同一个工作台。

**团队成员的日常是**：

- 打开团队自己的工作台，看到已启用模块的未读通知、今日日程和待办事项；
- 如果启用了 EdgeChat，点击“消息”进入单聊、群聊、文件和逐条已读回执；未启用时，系统不显示也不部署聊天模块；
- 从消息、任务或日历创建会议，会议模块使用 Cloudflare Worker/DO 提供信令，音视频优先在浏览器之间 P2P 传输；
- 使用可选的文档、看板、日历和 Git 动态模块；
- 邮件、身份、日历和文件存储可以使用团队已有服务，不要求必须使用 Stalwart 或 Cloudflare R2。

**管理员的日常是**：配置 OIDC、启用模块、绑定外部服务、管理本团队成员和权限、查看审计和备份状态。邮箱开户、停用等动作只有在配置了对应的 Provisioning 适配器时才自动执行。

## 2. 角色与权限

| 角色 | 谁 | 权限 |
|---|---|---|
| 管理员 | 该实例所属团队的管理员 | 管理本团队成员、模块、外部服务、审计和业务设置 |
| 用户 | 正式成员 | 使用已启用且被授权的模块 |
| 访客 | 外部协作者 | 只读或受邀参与指定模块，无默认团队权限 |

**身份原则**：Unself 不要求“邮箱账号 = 唯一身份”。登录统一使用部署者配置的 OIDC Provider；邮箱只是可选的通知和邮件能力。系统内部使用 `instance_id + issuer + sub` 识别用户，`email` 作为联系方式或显示字段。

## 3. 需求 → 模块 → 复用/自研 对照表

| # | 能力 | 默认实现 | 可替换实现 | 组合规则 |
|---|---|---|---|---|
| 1 | 统一身份 | 通用 OIDC | Stalwart、Keycloak、Authentik、Zitadel 等 | 必选基础能力，不绑定邮局 |
| 2 | 工作台 | 自研 Shell | Vue/React 前端部署 | 必选基础模块 |
| 3 | 即时通讯 | EdgeChat Cloudflare Worker + DO | 其他聊天系统适配器 | 可选，未启用时不显示“消息” |
| 4 | 日历 | CalDAV/iCalendar | Stalwart、Nextcloud、其他 CalDAV 服务 | 可选 |
| 5 | 看板/任务 | 自研轻量模块 | 外部任务系统适配器 | 可选 |
| 6 | Markdown 文档 | 自研模块 + 编辑器库 | 外部文档系统适配器 | 可选 |
| 7 | P2P 会议与会议记录 | Cloudflare Worker + DO 信令；浏览器本地录音/转写 | MiroTalk 或其他 WebRTC 信令服务；外部 ASR/AI | 可选；媒体默认不经过 Worker，文档输出和 AI 纪要均可选 |
| 8 | 文件存储 | S3 兼容适配层 | R2、MinIO、用户自备 S3 | 可选 |
| 9 | 邮件 | SMTP 适配器 | Stalwart、其他 SMTP 服务 | 可选，仅启用通知或邮箱能力时需要 |
| 10 | 资源开通 | 无 | Stalwart API、SCIM、Webhook | 可选，OIDC 本身不负责创建邮箱 |
| 11 | Git 动态 | Webhook 适配器 | Gitea、GitHub、GitLab | 可选 |
| 12 | AI/MCP | 平台协议和适配器 | 各模块自行提供工具 | 可选 |

## 4. 核心端到端链路（模块组合）

### 链路 1：新人入职（注册 → 审批 → 开号 → Gitea）

```
① 管理员部署 Unself，选择 Cloudflare 一键部署或 Docker 部署；
② 配置团队自己的 OIDC Provider；
③ 选择启用的模块，系统只注册和部署选中的模块；
④ 如果配置了 Provisioning 适配器，管理员批准成员后才执行对应系统的开户；否则只完成本团队成员授权；
⑤ 成员登录 OIDC 后进入统一工作台，只看到已启用且有权限的模块；
⑥ Gitea、邮件、日历等外部系统通过标准协议或适配器接入。
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

### 链路 3：创建会议（日历 → 邀请 → P2P 视频 → 会议记录）

```
① A 从消息、日历或工作台创建会议，填写时间和参会人；
② 日历模块通过 CalDAV 或 iCalendar 适配器创建/同步日程；
③ 如果邮件能力已启用，由配置的 Mail Provider 发送邀请，否则使用站内通知；
④ 到达会议时间，成员点击日程中的“加入会议”；
⑤ 统一壳向 Cloudflare Worker 请求会议房间，并通过 Durable Object 建立房间状态和 WebSocket 信令；
⑥ 浏览器交换 SDP 和 ICE Candidate，优先建立浏览器之间的 WebRTC P2P 媒体连接；
⑦ Worker 只承载鉴权、房间状态和少量信令，不承载音视频流量；
⑧ 直连失败时，可由部署者配置外部 STUN/TURN；需要 SFU、录制或大规模会议时，再接入独立服务；
⑨ 会议结束后，浏览器可本地保存音频和说话人信息，并本地转写，或由用户明确选择上传到配置的转写服务；
⑩ 生成的记录写入会议模块，并按配置输出到 Markdown 文档、通知、邮件或其他模块。
```

#### 会议记录与 AI 纪要

会议模块支持浏览器本地记录参会者音频和说话人信息。记录可以在本地直接转写为带说话人标记的文本，也可以由用户明确选择后上传音频或文本到配置的处理服务。会议音频和转写内容默认不经过会议信令 Worker。

会议结束后，转写结果可以：

- 保存为 Markdown 文档，并在会议记录页展示文档链接；
- 通过权限控制分享给团队成员或访客；
- 在未启用文档模块时，保留在会议模块中，以纯文本、HTML 或可下载 Markdown 的形式查看；
- 在配置 AI Provider 后，基于转写内容生成摘要、决定事项、行动项和会议纪要文档；
- 在启用了消息、邮件或日历模块时，将纪要链接或摘要发送到对应模块。

录音、转写、分享和 AI 处理均应在会议开始前明确提示并支持管理员策略控制。

### 链路 4：文件/附件（不占自家存储）

```
① 任何启用文件能力的模块请求上传；
② 统一存储适配层根据实例配置生成上传授权或上传地址；
③ 文件写入团队自己的 R2、MinIO 或其他 S3 兼容桶；
④ 业务模块只保存对象引用和元数据；
⑤ 更换存储后端不需要修改消息、文档和头像模块。
```

### 链路 5：Gitea 联动（通知内部化）

```
① Gitea、GitHub 或 GitLab 发送 Webhook；
② Git 适配器验证签名并转换为统一事件；
③ 如果启用了聊天模块，事件发送到 Git 动态频道；
④ 如果启用了邮件模块，事件可发送邮件通知；
⑤ 未启用对应模块时，事件写入审计日志或直接丢弃，不能依赖某个固定邮局。
```

### 链路 6：离职处理

```
① 管理员在管理页停用本团队成员；
② 核心权限服务立即撤销该成员的模块访问权；
③ 已配置的模块收到成员停用事件并清理会话；
④ 如果配置了 Provisioning 适配器，再调用对应系统禁用邮箱、应用密码或账号；
⑤ 可选：按照本团队策略归档成员数据到 S3。
```

## 5. 可插拔架构图（技术视图）

```
┌────────────────────────────────────────────────────┐
│       Unself Shell（Cloudflare Pages / Docker）      │
│  OIDC 会话 · 动态模块导航 · 权限 · 通知 · 配置       │
└──────┬─────────────┬─────────────┬─────────────────┘
       │             │             │
┌──────▼──────┐ ┌────▼─────┐ ┌────▼─────────────┐
│ Module      │ │ Core API │ │ Module Registry  │
│ Registry    │ │/Webhooks │ │ 启停与路由配置    │
└──────┬──────┘ └────┬─────┘ └──────────────────┘
       │             │
       ├─────────────┼──────────────────────────────┐
       │             │                              │
┌──────▼──────┐ ┌────▼──────────┐ ┌────────────────▼─┐
│ EdgeChat    │ │ Meeting       │ │ Calendar / Mail  │
│ 可选 Worker │ │ Worker + DO   │ │ 外部适配器        │
│ + DO        │ │ 只做信令       │ │ OIDC/SMTP/CalDAV  │
└─────────────┘ └───────┬───────┘ └──────────────────┘
                        │
             WebRTC P2P 媒体连接（不经过 Worker）
                        │
                可选外部 STUN / TURN / SFU

   文件：可选 S3 / R2 / MinIO
   部署：Cloudflare 一键部署优先，Docker 作为替代和扩展
```

### 5.1 模块契约（已拍板，2026-09-06）

模块是自包含的可部署单元。壳与模块之间只有三条通道，此外模块内部怎么实现，壳一概不知情：

```text
1. manifest   模块声明自己
2. module-sdk 模块与壳的桥：身份、通知、导航、主题
3. Core API   模块间互通只走核心，不走隔壁
```

manifest 只保留必要字段：

```yaml
id: chat.edgechat
route: /m/chat
entry: https://team.example.com/m/chat/   # 完整 URL，第一方默认同域路径
runtime: worker            # worker | docker | external
requires: [identity]       # 接受核心签发的模块 token
capabilities: [messaging]
version: 1.0.0
```

**装载器**：默认 iframe，对所有模块无例外（自研模块也住 iframe，逼契约诚实）。契约措辞是“iframe 是默认装载器”，不是“模块必须是 iframe”；未来某模块需要原生体验时可单独提升进壳，契约不变。

**不选微前端的理由**：模块代码进壳的构建系统会绑死技术栈、制造版本地狱，且 EdgeChat 衍生代码与核心代码可能进同一 bundle，破坏许可证边界。iframe 下模块独立构建、独立部署，第三方模块只要能起一个 HTTPS 站点即可接入。

### 5.2 模块身份与 token 交换（已拍板，2026-09-06）

规则只有一条：**全系统只有核心对接外部 OIDC，模块只认识核心。**

```text
① 成员在壳完成外部 OIDC 登录（PKCE），会话 Cookie 只在实例域名上
② 壳装载模块 iframe，模块 SDK 向壳发 ready 消息
③ 壳调核心 POST /api/modules/:id/token（核心校验模块启用与用户权限）
④ 核心签发模块 token，壳经 postMessage 交给 iframe（targetOrigin 校验）
⑤ 模块后端用核心 JWKS 验签、校验 aud，接受 Bearer 请求
⑥ token 过期前 SDK 静默续期，成员无感
```

| 参数 | 取值 | 理由 |
|---|---|---|
| 形态 | 核心签名的 JWT | 一个 JWKS 全平台通用，模块只需验签，不需懂 OIDC |
| aud | 模块 id | token 不能跨模块重放 |
| 有效期 | 10 分钟 + 静默续期 | 短时效是主要吊销手段 |
| sub | 核心内部稳定用户 id | `issuer + sub` 映射留在核心，换身份源不影响模块数据 |
| 交付 | postMessage 握手 | 不进 URL、不进 Cookie、不进日志 |

**踢人**：成员停用时核心广播停用事件（manifest lifecycle 钩子），模块立即清理；10 分钟 token 过期作为兑底上限。

**首个管理员**：部署完成输出一次性 setup token 链接；部署者打开并用 OIDC 登录自己，核心将该用户登记为管理员，setup 随即封死。不依赖身份源 groups claim，安全边界是“能读到部署输出的人 = 部署者”。

**登出**：壳清会话并广播登出消息，模块丢弃 token。外部身份源的 SLO 暂不做，标记为远期。

### 5.3 单域名路径路由（已拍板，2026-09-06）

第一方模块一律同域路径挂载，各自仍是独立 Worker/服务，按路径路由：

```text
team.example.com
├─ /            → Shell + Core API
├─ /m/chat/*    → 魔改 EdgeChat（独立 Worker，仅在启用时部署）
├─ /m/meet/*    → 会议信令（独立 Worker + DO，仅在启用时部署）
└─ /m/<其他>/*  → 其余第一方模块

Cloudflare：Workers Routes 按路径绑定
Docker：openresty 按 location 分发，两者等价
```

**安全模型**：不依赖浏览器 origin 隔离（同域下不存在），依赖 aud 锁定 + 10 分钟短时 token + 模块后端验签。同域共享 Cookie 无害：模块后端只认 Bearer，忽略 Cookie；第三方 Cookie 封杀问题随之消失。

**卫生规则**（由 SDK 自动处理）：路径前缀 `/m/<模块id>/`；存储键前缀 `unself.<模块id>.*`；同源也禁止直接互摸 DOM/存储，一律走 postMessage 契约。

**逃生口**：manifest.entry 是完整 URL。第三方模块如需浏览器级隔离，可填自己的域名，装载协议不变。

### 5.4 数据归属与存储（已拍板，2026-09-06）

规则：**状态存储归模块，基础设施服务归核心；数据边界靠契约执行，不靠物理分库。**

```text
D1 共 2 个库：
├─ core    用户、角色、模块注册表、会话、审计、setup token
└─ modules 全部模块业务数据，表前缀 = 模块 id
          （chat_messages / docs_documents / board_tasks …）

R2/S3：统一存储适配层，对象按模块前缀隔离（chat/ docs/ meetings/），
       模块只存对象引用，换桶不动模块
KV：共享命名空间，键前缀 unself.<模块id>.*
DO：每模块独立 DO 类，存储天然隔离
```

**为什么不分库**：分库买到的物理隔离已由 SDK 前缀收口 + 禁止跨模块外键覆盖；独立导出可用按表导出实现；写入争抢在 10 人规模不存在（D1 单写者，日写入千行级）。而分库要吃掉免费额度 7/10（上限 10 库/账户）并复杂化部署编排。边界执行者三件套：SDK 存储接口（模块拿不到裸连接）、禁止跨模块查询与外键（SDK 层拒绝）、按模块版本化的迁移。

**core 为什么单独一库**：平台命脉（登录、权限、审计）值得唯一一道物理墙——modules 库里任何模块的 purge 事故或迁移失控都炸不到 core。代价 1/10 额度。

**模块生命周期接口**（manifest 之外每模块必须实现）：

```ts
export(): Promise<ExportBundle>   // 按表前缀全量导出：JSON + 文件引用
purge():  Promise<void>           // 彻底清除本模块全部表与对象前缀
```

管理员卸载模块三选一：保留数据（默认）/ 导出并删除 / 直接删除。备份 = core 导一次 + modules 按表导出启用模块 + R2 整体，官方提供脚本。

**可逆性**：某模块数据量或写入暴涨时，可将其从 modules 库拆出独立库，SDK 配置切换，模块代码零改动。

### 5.5 部署编排（已拍板，2026-09-06）

装配与启停是两个操作：**装配在部署时做一次，启停在运行时随时做。**

```text
装配（provision）  建 D1、跑迁移、传 Worker、绑路由 —— 只在部署时执行
启停（toggle）     注册表开关 + token 门禁 —— 运行时秒级生效
```

**装配引擎 = wrangler 幂等脚本**（deploy/cloudflare），读唯一配置文件 `unself.config.jsonc`：

```jsonc
{
  "domain": "team.example.com",
  "modules": ["chat", "meet", "docs"],
  "storage": { "provider": "r2" }
}
```

脚本九步：① 确保 core/modules 两个 D1 存在；② 跑核心迁移与选中模块迁移（表前缀版本化）；③ 构建上传 Shell Worker；④ 每个选中模块构建、上传、绑 `/m/<id>/*` 路由与存储绑定；⑤ 注册表写入（选中 enabled，未选 not_deployed）；⑥ 建 R2 桶或接收外部 S3 参数；⑦ OIDC 不进配置文件——部署后在 setup 向导填写并存 core 库；⑧ 生成一次性 setup token 打印在部署输出末尾；⑨ 冒烟检查 `/api/health` 与各模块 health。

**一键入口**：Deploy to Cloudflare 按钮（默认模块集）+ Workers Builds（git 连接，配置变更 push 即自动重部署）。运行时进程不持有任何 CF API 凭证。

**运行时启停**：已部署模块由注册表开关控制——`enabled=false` 即边栏隐藏、core 停发对应 aud 的 token，存量 token 10 分钟内自然过期，数据原地保留。新增/移除模块 = 改 config → push → 自动重部署。

**失败与回滚**：脚本幂等，重跑收敛；回滚 = git revert + push（CF 亦保留 Worker 历史版本可秒回滚）；卸载走保留/导出删除/直接删除三选一。

**Docker 等价**：同一份 `unself.config.jsonc` → compose 服务 + openresty location + init 迁移容器。

**已知缺口**：setup 向导录入的 OIDC client secret 存于 core D1（无字段级加密），审计记录读取行为；字段级加密为远期选项。

## 6. 代码组织：可插拔 monorepo（用户拍板，2026-09-06）

monorepo 保留，目的是让核心协议、模块清单、适配器和部署配置可以在一个 PR 中协作。但第三方完整应用不通过 subtree 混入核心代码；它们保持独立构建边界，并以模块、服务或适配器接入。

```text
unself/
├── apps/
│   ├── shell/                # 统一壳，Cloudflare Pages / Docker
│   ├── admin/                # 实例配置和管理界面
│   └── portal/               # 可选注册、邀请和 Webhook 前端
├── modules/
│   ├── docs/                 # 自研 Markdown 文档模块
│   ├── board/                # 自研轻量看板模块
│   ├── calendar/             # CalDAV/iCalendar 前端模块
│   ├── chat-edgechat/        # EdgeChat 集成和必要补丁
│   ├── meeting-p2p/          # CF Worker + DO 信令模块
│   └── git/                  # Git Webhook 模块
├── services/
│   ├── core-api/             # 实例级 API、权限和审计
│   └── notification/         # 站内通知和可选邮件通知
├── adapters/
│   ├── oidc/                 # 通用 OIDC
│   ├── provisioning/         # Stalwart API、SCIM、Webhook 等
│   ├── mail-smtp/            # SMTP 邮件
│   ├── calendar-caldav/      # CalDAV
│   └── storage-s3/            # R2/MinIO/其他 S3
├── packages/
│   ├── contracts/            # 模块、身份、权限、通知协议
│   ├── module-sdk/            # 第三方模块开发 SDK
│   ├── ui/                    # 自研 UI 组件
│   ├── config/                # 模块清单和实例配置
│   └── mcp-tools/             # MCP/WebMCP 工具定义
├── deploy/
│   ├── cloudflare/            # 首选：Wrangler、绑定、迁移、一键部署
│   ├── docker/                # 替代部署和扩展组件 compose
│   └── examples/              # OIDC、SMTP、CalDAV、S3 示例
├── third_party/
│   └── components.yaml        # 外部组件版本、来源和许可证清单
└── .github/workflows/         # 按模块和部署目标构建
```

**第三方代码引入规则**：
1. 可复用库使用 package 依赖；
2. 独立服务使用发布镜像、HTTP API 或模块 URL；
3. 必须维护 fork 时，优先使用独立 fork 仓库或 submodule；
4. 不使用 subtree 把 EdgeChat、MiroTalk 的完整历史和源码混入核心；
5. `third_party/components.yaml` 固定版本、来源、构建方式和许可证。

**许可证边界**：核心、自研模块和协议包使用 Unself 自己选择的许可证；包含或修改 EdgeChat 代码的模块遵守其 GPL；包含或修改 MiroTalk 代码的模块遵守其 AGPL，并保留上游版权和许可证。独立服务、独立构建产物和标准协议边界不能替代正式许可证审核。

## 7. 部署拓扑

```text
一次自托管实例（默认部署到团队自己的 Cloudflare 账户，单域名）

team.example.com
├─ /                → Shell + Core API / Module Registry（Workers）
├─ /m/chat/*        → 魔改 EdgeChat 模块（仅在启用时部署）
├─ /m/meet/*        → P2P 信令 Worker + Durable Object（仅在启用时部署）
├─ /m/<其他>/*      → 其余第一方模块，同样按路径挂载
├─ /api/*           → Core API 与 Webhook
└─ 附件             → 可选 R2/S3/MinIO（外部服务，不占实例域名）

外部可选服务（各自独立域名，不属于实例域名）：
├─ 邮局             → 团队自己的 SMTP/OIDC/CalDAV
├─ 日历             → 团队自己的 CalDAV
└─ TURN/SFU/录制    → Docker 扩展

Docker 等价部署：单域名 + openresty 按 location 分发到各模块服务。
第三方模块如需浏览器级隔离，在 manifest.entry 填自己的域名即可，契约不变。
```

Cloudflare 是官方首选部署目标，但不构成第三方团队的强制基础设施。Docker 部署必须提供等价的核心配置和模块启停能力。

## 8. 里程碑

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **M0** | 垂直切片：contracts、module-sdk、core-api、shell、hello 模块、幂等部署脚本 | 七步剧本全绿：部署出 setup 链接 → 首个管理员登录 → hello iframe 全链路（握手/token/JWKS/SDK 存储）→ 启停秒级生效 → 移除模块重部署后路由消失 |

M0 技术栈（已拍板 2026-09-06）：TypeScript + Hono + Vue 3 + Vite + Tailwind + zod + jose + pnpm workspaces + Vitest。
| **M1** | 动态边栏、权限、通知中心、Docker 替代部署 | 模块可启停，未启用模块不出现在边栏 |
| **M2** | EdgeChat 可选模块 + OIDC 接入 | 仅启用聊天的团队可部署并使用消息功能 |
| **M3** | 逐条已读回执和 Git Webhook | 消息已读状态、Git 动态按模块工作 |
| **M4** | CalDAV 日历 + P2P 会议 Worker/DO + 会议记录 | 日历创建会议，浏览器优先 P2P，Worker 不承载媒体；会后可回顾记录 |
| **M5** | 文档、看板、S3 适配层 | 任务截止日期与日历联动，会议记录可输出为 Markdown 文档，文件写入用户配置的存储 |
| **M6** | Provisioning、MCP、TURN/SFU 扩展和移动端 | Stalwart/SCIM/Webhook 可选开户，复杂网络可接入外部媒体服务 |

## 9. 风险与决策点

| 风险/决策 | 现状 | 建议 |
|---|---|---|
| CF 一键部署 | 官方首选，但不是强制绑定 | 首先保证 Cloudflare 模板和向导体验，再提供 Docker 等价路径 |
| 模块可选部署 | 未启用模块不应创建资源或显示导航 | 由 Module Registry 统一管理 manifest、依赖和启停 |
| EdgeChat 许可证 | EdgeChat 模块使用 GPL | 独立构建、保留许可证和修改源码，核心不复制其代码 |
| MiroTalk/会议许可证 | MiroTalk 代码使用 AGPL | 会议信令优先自研 CF Worker；若使用 MiroTalk fork，独立构建并遵守 AGPL |
| OIDC Provider | 每个部署者自行配置 | 核心只依赖标准 OIDC；Stalwart、Keycloak、Authentik 作为适配/示例 |
| 邮箱开户 | OIDC 不负责创建邮箱 | 通过可选 Provisioning 适配器支持 Stalwart API、SCIM 或 Webhook |
| P2P 会议 | Worker 只处理鉴权、房间和信令 | 默认浏览器直连；TURN、SFU、录制作为外部扩展 |
| 统一壳工作量 | 自研核心能力 | 先做模块协议和动态边栏，第三方模块通过 URL/API 接入，不强行重写全部 UI |
| 模块装载 | 模块与壳不能互相侵入 | 默认 iframe 装载器 + manifest/module-sdk/Core API 三通道；自研模块同规适用，微前端不采用 |
| 模块身份 | 模块不应接触外部 OIDC | 只有核心对接 OIDC；模块收核心签发的 aud 锁定短时 token，后端只验签 |
| 首个管理员 | 部署完成到管理员产生之间实例无主 | 一次性 setup token，用后立即封死 |
| 域名 | 多域名增加部署、证书与访问成本 | 单域名路径制 `/m/<模块>/`；安全靠 token 验签而非 origin 隔离；第三方模块可填独立域名 entry |
| 模块数据耦合 | 共库后模块互相踩表 | 单一 modules 库 + 表前缀 + SDK 查询收口 + 禁止跨模块外键；export/purge 按前缀执行；core 库物理独立护住平台数据 |
| 部署编排 | 运行时持凭证风险高；装配失败难恢复 | 装配只在部署时由 wrangler 幂等脚本执行，实例不持 CF 凭证；启停走注册表开关 + token 门禁；配置 push 即自动重部署 |

## 10. Cloudflare 首选部署容量参考（本团队）

> 注：CF 额度按**账户**计，不按成员。团队共用一个 CF 账户，成员只是应用内的用户 → **额度天然共享，无需“合并”**。

| 资源 | 免费层 | 10 人团队估算 | 结论 |
|---|---|---|---|
| Workers 请求 | 100K/天 | 聊天+门户 ~2-5K/天 | ✅ 用不到 5% |
| Durable Objects 请求 | 100K/天 | WS 连接 + 消息事件 ~1-3K/天 | ✅ 余量极大 |
| DO 时长 | 13,000 GB-s/天，Hibernation 不计量 | 几乎为 0 | ✅ |
| DO SQL 读 | 50M 行/天 | 分页拉历史 ~数十万行 | ✅ |
| DO SQL 写 | 100K 行/天 | 消息+回执 ~数千行 | ✅ |
| D1（2 库：core + modules） | 库数上限 10 个/账户，实际只用 2 个；单库 500MB，账户总 5GB；读 5M 行/天，写 100K 行/天（2026-09-01 起超限硬报错） | 读写远低于限额；单库 500MB 对 10 人团队为数年余量 | ✅ 某模块暴涨时可拆出独立库（SDK 配置切换） |
| KV | 读 100K/天，写 1K/天，1GB | 会话存储 ~几十次/天 | ✅ |
| R2 文件 | **10GB 存储**，A 类 1M/月，B 类 10M/月，**出流量免费** | 10 人附件，起步期 1-2GB | ✅ 存储满后可自备桶 |
| Workers AI | **10K neurons/天** | 小模型助手对话约几十~上百轮/天 | ⚠️ 最紧的一项 |
| Pages 静态托管 | 无限制 | 统一壳前端 | ✅ |

**结论**：除 AI 与 D1 库数量外全部轻松覆盖，10 人团队基本零成本。三个升级触发点：
1. AI 用量超 10K neurons/天 → Workers Paid $5/月起，超出按 $0.011/千 neurons 计费（单次对话约几分钱）
2. R2 存满 10GB → 切换用户自备 S3 桶（存储适配层本来就支持）
3. 某模块接近单库 500MB 或写入逼近限额 → 将该模块从 modules 库拆出独立库（SDK 配置切换），或升级 Workers Paid（单库 10GB、库数 5 万）

## 11. AI 接入能力调研

### 11.1 两种协议：WebMCP vs 经典 MCP（关键区分）

| | WebMCP（EdgeChat 已接入） | 经典 MCP（本地 agent 主流） |
|---|---|---|
| 形态 | 页面在 ChatGPT 桌面版内置浏览器里打开时，通过 `document.modelContext.registerTool` 注册站点工具 | 独立服务进程（stdio/HTTP/SSE），agent 客户端主动连接 |
| 支持方 | OpenAI Codex/ChatGPT Work（实验标准）；社区桥接 `chgold/webmcp-client` 可接 Claude Desktop | Claude Desktop、Cursor、Copilot、自定义本地 agent 等全部支持 |
| EdgeChat 现状 | ✅ 已实现，注册 5 个工具：`edgechat.login / list_channels / read_messages / send_message / open_dm`（frontend/src/webmcp.ts，261 行） | ❌ 无现成 MCP server，也无 CLI（源码确认：仅 webmcp.ts + Telegram 桥） |

### 11.2 本地 agent 接入方案（基于源码调研）

EdgeChat 有完整 REST API（`/api/auth/login`、`/api/messages`、`/api/messages/read`、`/api/ws/...` 实时票券等），**写一个 200 行左右的 MCP server 包装这些端点即可让任意本地 agent 读写聊天**。

| 接入方式 | 工作量 | 适用 |
|---|---|---|
| 用现成 WebMCP（ChatGPT/Codex 浏览器） | 零 | 你在 ChatGPT 桌面版里操作聊天 |
| 社区桥接（webmcp-client）接 Claude Desktop | 低 | 用 Claude Desktop |
| **自建 MCP server（包装 EdgeChat REST API）** | 小（~200 行） | 任意本地 agent（Claude/Cursor/自写 agent/手机端 agent） |
| **统一平台 MCP server（聊天+日历+邮件+看板）** | 中（一个服务全模块） | 终极形态：本地 agent 像管理员一样操作整个平台 |

### 11.3 Workers AI 平台推理（另一件事）

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
