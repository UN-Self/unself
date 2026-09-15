# M1 验收记录（2026-09-14）

> 验收对象：`team.handywote.top` 生产实例，部署版本 = `58a0f1c`（m1/dev 合并链：#148 → #159 全量上线）
> 验收方式：**双版本实机走查**（操作者按真实用户动线逐屏操作）+ 关键环节 D1/JMAP 取证
> 对应 issue：[#22 M1-f 双版本入职闭环验收](https://github.com/UN-Self/unself/issues/22)

## 1. 验收结论

| 形态 | 动线 | 结论 |
|---|---|---|
| **完整形态**（内置身份 + Stalwart 邮件轴） | 邀请 → 填表（含邮箱前缀/个人邮箱）→ 批准（秒回）→ 邀请页三态 → 设置邮箱密码 → 登录 | ✅ 通过 |
| **弱化形态**（无邮件实例） | 设置页开关关闭 → 邀请表单无邮箱字段 → 批准即激活 → 「全部就绪，去登录」→ 登录 | ✅ 通过 |

两形态共用同一份代码，切换只依赖实例邮件轴开关（`instance_config.mail.enabled`），无需重新部署。

## 2. 完整形态证据链

| 环节 | 观察结果 | 取证 |
|---|---|---|
| 邀请创建 | 管理台生成一次性限期链接 | audit `invite_created` |
| 新人填表 | 表单含「邮箱前缀 + 个人邮箱」（mailEnabled=true） | 页面实录 |
| 管理员批准 | **秒回**（不等待邮件投递）；响应含开户结果 | audit `invite_approved` |
| 开户 | Stalwart 真实建号（JMAP `x:Account/set`，0.16.20 形状） | JMAP 账号查询存在 |
| 工作邮箱回填 | `users.email` = `<前缀>@unself.cn`（#149 修复后） | D1 `SELECT email FROM users` |
| 站内通知 | `account_ready` / `invite_result` 落库（邮件通道=后台尽力，CF 平台限制见 §5） | `notifications` 表 |
| 邀请页三态 | `pending`（审批中）→ `approved`（设置邮箱密码）→ `activated`（去登录） | `GET /api/invite/:token/status` 三态实测 |
| 设置邮箱密码 | 邀请页 claim 重签 → 设置密码成功；随后 Stalwart 账号可用新密码登录（IMAP/JMAP 侧可验证） | audit `activation_claimed` / `account_activated`；`invite_activations.used_at` 置位 |
| 登录工作台 | 内置身份（注册时设的密码）登录成功，模块可用 | 页面实录 |

**负例回归（走查现场修复项）**：弱密码被 Stalwart 策略拒绝时 → 400 中文人话 + **令牌回滚**（同链接换强密码重试即成功），不再出现「失败即烧链接」。

## 3. 弱化形态证据链

| 环节 | 观察结果 | 取证 |
|---|---|---|
| 邮件轴开关 | 设置页关闭开关：配置区带过渡收起、测试连接禁用、提示文案在场；**切换本身不发请求，保存才落库** | 页面实录 + F12 Network |
| 开关持久化 | 刷新页面后状态保持；`mail.enabled=false` 落库 | D1 `instance_config.mail` |
| 邀请表单 | 无「邮箱前缀 / 个人邮箱」字段，仅显示名 + 用户名 + 密码 | 页面实录 |
| 批准 | 无开户动作，**批准即激活** | `configuredMailProvisioner` 返回 null 路径 |
| 邀请页 | 直接显示「全部就绪，去登录」（无「设置邮箱密码」） | `GET .../status` → `mailEnabled:false` + `activated` |
| 登录 | 内置身份直接登录，全程零邮件依赖 | 页面实录 |

## 4. 走查期间发现并修复（6 项，全部已合并）

| Issue | PR | 内容 |
|---|---|---|
| #148 | #154 | Stalwart **0.16.20 形状漂移**：`credentials` 变索引 List → resetPassword 改数字键；顺带挖出 **disable 的 permissions 旧形状从未生效**（改 Merge+map），真实服务器双向实测 |
| #149 | #155 | 实例能力开关 `mailEnabled` 公开 + 邀请页条件化（无邮件不渲染邮箱字段）+ `users.email` 回填 |
| #150 | #153 | 激活错误映射（409/502 人话）+ 邮件测试探测器分级超时（不再挂死） |
| #151 | #156 | **激活失败回滚令牌**（先消费后干活 → 失败精确回滚） + 弱密码拒绝映射 400 中文人话 |
| #157 | #158 | 邮件轴开关（`mail.enabled` 持久化，关≠删配置；老数据缺省开启） + `USwitch` 基元 |
| #159 | #160 | 开关改表单语义（保存才落库）+ 折叠过渡动效（tokens / reduced-motion 降级） |

**M1 复核阶段（09-14 验收之后）发现并已修（7 项，全部已合并在 M2 波次 0）**：

| Issue | 内容 |
|---|---|
| #165 | 未封箱窗口接管面加锁：builtin-admin 加 setup token 门 + 删公开签发口 |
| #166 | 工作台补管理台入口（桌面侧栏 + 手机「我的」，仅 admin 可见） |
| #167 | 发信轴吃 `mail.enabled`——关闭即不装配 sender |
| #168 | 应用密码说明页（A1）：步骤说明 + 门户跳转 |
| #169 | `verify-tokens` 跳过 `*.test.*/*.spec.*` 误报 + CI 接入闸门 |
| #170 | #151 回滚精确守卫：作废记号可区分（同秒回滚不复活已作废令牌） |
| #171 | setup token 消费记录补 `used_by`（#49 验收项 5 补齐） |

## 5. 平台限制入档

- **CF Workers 出站 TLS 平台不可用**（决策 #31，证据档案 issue #127）：`secureTransport:'on'` 实际不发 TLS、`startTls()` 死于 workerd#2712、25 端口硬禁。
- 因此产品定位：**邮件发送 = 后台尽力增强（失败不阻塞任何主流程）**；激活/入职的必经通道 = 邀请页三态自助。
- 可靠发信走服务器侧轮询发送器（M2，issue #135）。

## 6. 未决与交接

（#130 / #120 两行已于 09-14 关单执行，保留在此仅为交接留痕；其余四项仍待办。）

| 项 | 归属 |
|---|---|
| #152 resend-activation 改造（后台化/失败保留旧令牌/语境文案） | M2 |
| #135 服务器侧邮件轮询发送器 | M2 |
| #121 zxcvbn 前端强度计 / workerd PBKDF2 上限跟进 | M2 备忘 |
| #21 「邮箱凭据页」A2 占位 | M6 |
| #130 收官清理（探针 Worker×12、服务器 8465 实验配置回滚、临时文件） | 已执行（09-14 关单，探针 Worker/8465 回滚/临时文件已清） |
| #120 已暴露凭据统一轮换（CF token / SSH root / Stalwart API key 等） | 已执行（09-14 关单，由用户自行轮换） |

## 7. 验收资产

- D1 清理记录：`/tmp/unself-cleanup-prod-0914.md`（含逐表变更行数与终态计数）
- 邮件配置备份：`/tmp/mail-config-backup.json`（弱化形态切换前后恢复用，原值已恢复）——**已于 #130 清理**（含 API key/密码的本机临时文件，见 #130 关单记录）
- 生产终态：users=1（admin）· invites/activations/notifications/audit 全 0 · Stalwart 账号 = admin/handy/no-reply（无测试孤儿）

## 8. M1 后补：手机 375px 复走查（#172）

> 走查日期 2026-09-15 · 视口 **375×812**（deviceScaleFactor=2）· 基线 `382c15b`（m2/dev，含 #166 管理台入口 + #167/#170）
> 实录全文 `/tmp/m2-172-walkthrough.md`；截图 37 张 `/tmp/m2-172-01-*.png` … `/tmp/m2-172-37-*.png`

**结论**：手机 375px **可完成全链路审批**——8 步动线全通，含手机端真实点击「批准」两次（状态行内翻转 + D1 `invites.status=approved` + `audit_log: invite_approved`），邀请页三态（待审批 → 已批准 → 已激活）窄屏可读可点，三态 `scrollWidth=375` 无横向溢出；`member` 身份手机端看不到管理台入口，且服务端 `GET /api/admin/invites` 返回 403（前端隐藏 ≠ 权限）。

**限定（结论只在此范围内成立）**：

| # | 限定 |
|---|---|
| L1 | 邮件轴（开户/改密）走 contracts 内存假 provisioner；本地无 Stalwart，**不构成对真 Stalwart 形状的复核**（生产 0.16.20 形状见 §2） |
| L2 | 假 provisioner 工作邮箱写死 `@example.com` → 域名拼接规则本次未覆盖 |
| L3 | 默认不注入 provisioner 时假实现每请求新建 → 第 8 步「设置邮箱密码」必失败（`ACCOUNT_NOT_FOUND`）。这是本地验收环境限制，不是产品缺陷；假实现提到模块作用域后一次通过 |
| L4 | 桌面 Chromium 375×812 视口 + `tap` 语义，未覆盖真机触摸/软键盘/横屏/320px；生产未参与（零生产流量） |

**本次新发现（均未当场修，已开 issue）**：

- #180 管理台顶部导航末项「设置」375px 被裁切（`scrollWidth=366 > clientWidth=343`，滚 23px 可达但无滚动提示）
- #181 移动端触屏目标偏小（管理导航 32px、邀请行批准/拒绝 32px、动作单行 40px、通知铃 32px；≥ WCAG 2.5.8 的 24px 底线，属体验打磨）
- #182 本地验收阻断：contracts 假 provisioner 每请求新建 → 完整形态第 8 步必失败（= L3；建议 dev 入口或 testing.md 固化「进程内单例 fake」走法）
- #184 `portalUrl` 无设置页输入位（#168 字段只能靠推导或直接调 API）
