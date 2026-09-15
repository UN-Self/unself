# 决策档案（编号 + 日期 + 结论 + 来源；只增不改）

> 本文件是 Unself 全部拍板决策的唯一去处。规则：**只增不改**——已编号条目的结论不重写；更正与补充另开新条目（或新编号）。
> 编号沿革：`#1–#34` 沿用 docs/requirements.md 原「已确认架构决策」表编号（2026-09-06 表；表内个别条目带后续修订日期，见「日期」列）。**原表存在两个 `#31`（发信定位 / 模块三分法），本文件保留原编号、不重排**；新增条目自 `#35` 起顺延。
> 来源：`docs/requirements.md` 原 §6（2026-09-06）；`docs/PRODUCT_SPEC.md` v3 §6.6 M1 产品化决策记录（2026-09-07）；散落各章的拍板条目（各自标注日期与出处）。文中「SPEC §x」均指拆分前的 PRODUCT_SPEC v3 原文（现索引页见 docs/PRODUCT_SPEC.md）。
> 「结论」列保留原文措辞；原文含理由的随文保留，不另行补写。决策正文的展开位置：定位与产品 → docs/product.md；架构与契约 → docs/architecture.md；链路 → docs/flows.md；里程碑 → docs/roadmap.md。

| # | 日期 | 决策 | 结论 | 来源 |
|---|---|---|---|---|
| #1 | 2026-09-06 | 产品形态 | 自托管软件，不提供中央 SaaS 或多租户托管平台 | requirements.md §6 #1 |
| #2 | 2026-09-10 | 首选部署 | Cloudflare Workers（按量计费）；正式路径 = 交互式装配器 CLI；一键入口（Deploy Button + Workers Builds）为路线图（2026-09-10 修订） | requirements.md §6 #2 |
| #3 | 2026-09-06 | Docker | 作为替代部署和扩展能力，不与 CF 主路径竞争 | requirements.md §6 #3 |
| #4 | 2026-09-10 | 身份 | 登录能力核心内建：内置账号（用户名+密码）为默认；外部 OIDC 为可选增强；支持任意兼容身份源或支持 OIDC 的邮局；身份不是模块（2026-09-10 修订） | requirements.md §6 #4 |
| #5 | 2026-09-06 | 模块 | 聊天、日历、文档、看板、会议、Git、邮件均可选；未启用则不显示、不部署 | requirements.md §6 #5 |
| #6 | 2026-09-06 | 即时通讯 | EdgeChat 是官方 Cloudflare 模块，使用 Worker + Durable Objects；可在未来接入其他实现 | requirements.md §6 #6 |
| #7 | 2026-09-06 | 会议 | Cloudflare Worker + DO 做信令，浏览器 WebRTC P2P 传媒体；TURN/SFU/录制作为外部扩展 | requirements.md §6 #7 |
| #8 | 2026-09-06 | 日历与邮件 | CalDAV/iCalendar 与 SMTP 为通用协议；Stalwart 是官方参考适配器 | requirements.md §6 #8 |
| #9 | 2026-09-06 | 代码组织 | 单一 monorepo 管理核心、模块、适配器和部署；第三方完整源码保持独立构建边界 | requirements.md §6 #9 |
| #10 | 2026-09-06 | 许可证 | **核心 = AGPL-3.0**（防 SaaS 白嫖，威胁模型明确）；EdgeChat 衍生件遵守 GPL-3.0（独立 Worker）；重写的 EdgeChat 前端为自研归 AGPL；MiroTalk 衍生件遵守 AGPL-3.0；边界靠构建产物判定，LICENSE/NOTICE/components.yaml 落仓库；贡献用 DCO | requirements.md §6 #10 |
| #11 | 2026-09-06 | 模块装载 | 模块为自包含部署单元；默认 iframe 装载器，第一方同域路径挂载，微前端不采用；契约不写死 iframe | requirements.md §6 #11 |
| #12 | 2026-09-06 | 模块身份 | 核心统一身份（内置或 OIDC）并签发模块 token；模块只验 token，不接触身份源 | requirements.md §6 #12 |
| #13 | 2026-09-06 | 域名 | 单域名路径制 `/m/<模块>/`；Workers Routes 与 openresty location 等价；第三方模块可用独立域名 entry | requirements.md §6 #13 |
| #14 | 2026-09-06 | 数据归属 | 两个 D1：core（平台数据，物理独立）+ modules（全部模块业务数据，表前缀=模块id）；R2 统一适配层按前缀隔离；export/purge 为模块生命周期契约；模块一律经 SDK 存储接口访问，禁止跨模块查询与外键 | requirements.md §6 #14 |
| #15 | 2026-09-10 | 部署编排 | 装配 = wrangler 幂等脚本读 `unself.config.jsonc`，只在部署时执行，实例不持 CF 凭证；装配器是产品核心交互（token 深链接→三选→九步→错误归属）；Deploy Button + Workers Builds 为路线图一键入口；已部署模块启停 = 注册表开关 + token 门禁，秒级免部署；Docker 读同一份配置（2026-09-10 修订） | requirements.md §6 #15 |
| #16 | 2026-09-06 | M0 技术栈 | TypeScript + Hono + Vue 3 + Vite + Tailwind + zod + jose + pnpm workspaces + Vitest；M0 = hello 模块七步验收剧本 | requirements.md §6 #16 |
| #17 | 2026-09-06 | 会议记录 | 音频存档永不上云；转写两档（云/机密强制本地），主持人选定、成员可 opt-out；房间时钟统一时间轴，散场只传纯文字由 Worker 合并；核心代调 act claim + 通用 ACL（参会者读、主持人写）；AI 纪要经 SDK 能力；个人片段参会者互见 | requirements.md §6 #17 |
| #18 | 2026-09-06 | 前端约定 | 设计令牌单一来源（tokens.css + Tailwind @theme，禁裸值）；组件查找序 beUI→shadcn 生态→手写（beUI 动效参数照抄移植 Vue）；基元内聚住 packages/ui；图标只用 Lucide（manifest 存图标名，拒绝 emoji）；中文写死、亮色单主题、系统字体 | requirements.md §6 #18 |
| #19 | 2026-09-06 | 手机原则 | 平台级要求：一切界面 mobile 可用 = 能看 + 轻操作；重编辑/重管理允许桌面增强（按操作深度分不按功能分）；工作台壳双形态：桌面左栏 / 窄屏底部标签栏（同一 nav 数据）；PWA 安装化在 M6 | requirements.md §6 #19 |
| #20 | 2026-09-10 | 身份与门户 | 内置账号为默认登录（密码表单 + SSO 按钮并存，按实例配置显隐）；已有 OIDC 账号首登自动建档复用（JIT，核心只存 issuer+sub 映射）；内置用户密码哈希存 core（2026-09-10 修订） | requirements.md §6 #20 |
| #21 | 2026-09-06 | setup 动线 | 仅部署输出的一次性链接可配置；激活即成管理员并直接进工作台；已激活后 /setup 访问一律重定向，页面不复存在 | requirements.md §6 #21 |
| #22 | 2026-09-06 | 可观测性 | 错误三层透传：成员只见人话+request id；管理员登录态可展开技术详情；服务端 wrangler tail + audit_log，request id 串联排查 | requirements.md §6 #22 |
| #23 | 2026-09-13 | 邮箱可选 | 身份轴与邮件轴正交；邮件轴关闭时批准只翻状态（无开户无发信），内置模式批准即激活；实例特定值（域名/发件地址/API key）= 运行时配置（/admin/settings mail 段，即改即生效免重部署）（2026-09-13 对齐实现） | requirements.md §6 #23 · SPEC §6.6「邮箱域名」（互为补充，SPEC 侧独有措辞：存 core 库 instance_config；API key 保管在 wrangler secret，运行时经设置页读写（读出即 masked）） |
| #24 | 2026-09-13 | 邀请激活 | 邀请链接一次性/限期（默认 7 天）；批准 → 开户（随机初密）+ 后台尽力发信（发信失败不阻塞审批）；激活必经通道=新人凭邀请链接回邀请页三态自助（待审批/设置邮箱密码/去登录），claim 原子重签（单一有效链接、明文不落库）；不经管理员转交；内置无邮件模式批准即激活——注册时设密码（2026-09-13 #134 修订） | requirements.md §6 #24 · SPEC §6.6「新人凭据」（互为补充，SPEC 侧独有措辞：批准=开户+签激活令牌；邮件后台尽力投递（非必经）；邀请表单收个人邮箱字段） |
| #25 | 2026-09-06 | 账号移除 | 禁用 = 摘 authenticate 权限位（数据保留、可逆）；删除只在链路 6 完整版（导出后可选）出现 | requirements.md §6 #25 · SPEC §6.6「移除成员」（互为补充，SPEC 侧独有措辞：数据原地保留） |
| #26 | 2026-09-06 | 通知承载 | 通知类型表（type/文案模板/渠道位），类型是数据不是代码；模块经 SDK 触发为后续扩展路 | requirements.md §6 #26 · SPEC §6.6（同结论，措辞微差：模板/文案模板、后续路/后续扩展路） |
| #27 | 2026-09-06 | 入职门型 | 邀请制唯一入口：一次性+限期链接（默认 7 天，1-365 可调）；批量门（限次限时）为扩展位；永久链接与开放注册不做 | requirements.md §6 #27 |
| #28 | 2026-09-06 | 双门语义 | 邀请链接管「谁能填表」，审批管「谁能进门」；注册表单（内置模式含用户名+密码）入库即 pending，批准即 active | requirements.md §6 #28 |
| #29 | 2026-09-06 | 密码两用途 | 登录密码与邮箱密码是两个密码；合一只在 Stalwart 兼任 IdP 时巧合成立，非产品承诺；忘记密码 = 管理员手动重置（无邮件实例唯一恢复路径） | requirements.md §6 #29 |
| #30 | 2026-09-06 | 用户名唯一性 | 注册时软校验（users+invites 双表查重即时反馈）；批准时硬校验（撞名走可恢复冲突：invite 留 pending + 人话提示） | requirements.md §6 #30 |
| #31 | 2026-09-13 | 发信定位 | CF Workers 出站 TLS 平台不可用（2026-09-13 定案，证据档案 issue #127）：服务端发信=后台尽力增强、失败不阻塞审批；激活交付=邀请页三态自助（决策 #24） | requirements.md §6 #31 · SPEC §5.7 |
| #31 | 2026-09-10 | 模块三分法 | 功能模块（原生 Worker）/ 适配器（包一层外部系统）/ 伴生服务（整台外部服务只做配置接线）；开发、部署、信任边界各异 | requirements.md §6 #31 · SPEC §3 |
| #32 | 2026-09-06 | 官方改编纪律 | fork 只为省时间；默认不跟上游、看情况选择性吸收；继承上游许可证；改造按 L0-L3 适配光谱（官方功能模块走 L3 深度重写）；第三方 DX（sdk 文档/脚手架）是产品面 | requirements.md §6 #32 |
| #33 | 2026-09-06 | 装配交互 | 正式部署路径 = 交互式 CLI：缺 token 打印深链接（权限预填）→ 域名三选（workers.dev 显式第一选项）→ 模块确认 → 九步进度 + 失败三要素（原因/归属/修复）→ 收尾下一步指引；幂等重跑 | requirements.md §6 #33 |
| #34 | 2026-09-06 | 升级迁移 | 已入主的迁移文件永不修改；schema 演进一律新增 `000N_*.sql`；`migrations apply` 幂等收敛；替代 M0 直改 init.sql 做法 | requirements.md §6 #34 · SPEC §5.5 |
| #35 | 2026-09-07 | 邮箱开户抽象 | MailProvisioner 四方法接口（createAccount/disable/enable/resetPassword）住 contracts；Stalwart JMAP 是第一个实现，后续团队可接 Mailcow 等 | SPEC §6.6 |
| #36 | 2026-09-07 | 管理通道凭证 | Stalwart API key（Bearer，最小权限集），wrangler secret 保管，运行时经 /admin/settings 读写（读出即 masked）；不用人账号 Basic | SPEC §6.6 |
| #37 | 2026-09-07 | 应用密码 | M1 = 引导页（跳转 Stalwart 自服务门户）；「邮箱凭据页」用户 token 代调 = A2，排 M6 | SPEC §6.6 |
| #38 | 2026-09-07 | 审批流 | 单级审批，任何管理员可批拒；桌面管理页主入口，手机同页响应式 | SPEC §6.6 |
| #39 | 2026-09-07 | 管理界面位置 | shell 内 admin 路由（角色守卫），apps/admin 目录预留独立台 | SPEC §6.6 |
| #40 | 2026-09-07 | M1 验收形态 | 三形态：内置+无邮件（默认路径全程）/ OIDC+无邮件 / OIDC+Stalwart（真邀一人全程不碰 Stalwart 后台，真实投递） | SPEC §6.6 |
| #41 | 2026-09-06 | 跨模块协作三原语 | 核心代调与 act claim（双主体 token）+ 核心通用 ACL（资源级权限）+ SDK AI 能力（ai.complete()，Provider 配置归核心） | SPEC §5.6 |
| #42 | 2026-09-09 | 第三方模块发布契约 | 模块作者不部署只发布，部署永远是实例侧动作；信任无分级（写部署脚本的人 = 信任决策者）；主题与部署解耦（模块产物只含令牌名，值运行时下发） | SPEC §5.5.1 |
| #43 | 2026-09-09 | 主题令牌契约边界 | 语义令牌清单发布后只增不改名、不删项；动效不在契约内（归模块作者自治，平台只保证静态视觉一致；动效令牌仅为平台内部默认值） | SPEC §6.5.2 |
| #44 | 2026-09-10 | 产品定位 | Unself 交付壳/契约/装配器三样；模块是载荷不是产品；能力轴模型（每项能力一根轴，壳+契约是常量、模块是变量） | SPEC §0 |
| #45 | 2026-09-07 | 贡献协议 | M0 阶段用 DCO（sign-off 即可）；CLA 仅在未来需要商业双重授权时再议 | SPEC §6.6（尾部孤立条目） |
| #46 | 2026-09-15 | CORS 不配置 | 同源部署（壳与模块同域，模块走 `/m/<id>/*`），浏览器同源策略即兜底；主动配 CORS 反而扩大暴露面。将来支持 `runtime: external` 外部模块时再按白名单显式配置 | M1 复核 S9 |
| #47 | 2026-09-15 | 反点击劫持 | 外壳 HTML 加 `Content-Security-Policy: frame-ancestors 'self'` + 基础 CSP（`default-src 'self'`），`X-Frame-Options: SAMEORIGIN` 兼容旧浏览器；模块 iframe 页面由模块 worker 自负（本波未加，登记已知限制） | M1 复核 S8 |
| #48 | 2026-09-15 | Stalwart 终态自述不再独立核验 | 复核环境无 Stalwart 管理凭据，终态只能采信服务端自述；用户认可不再投入（真要独立核验 = 重装实例）。此项**取消**，非推迟 | M1 复核 X2 |
