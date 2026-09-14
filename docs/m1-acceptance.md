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

## 5. 平台限制入档

- **CF Workers 出站 TLS 平台不可用**（决策 #31，证据档案 issue #127）：`secureTransport:'on'` 实际不发 TLS、`startTls()` 死于 workerd#2712、25 端口硬禁。
- 因此产品定位：**邮件发送 = 后台尽力增强（失败不阻塞任何主流程）**；激活/入职的必经通道 = 邀请页三态自助。
- 可靠发信走服务器侧轮询发送器（M2，issue #135）。

## 6. 未决与交接

| 项 | 归属 |
|---|---|
| #152 resend-activation 改造（后台化/失败保留旧令牌/语境文案） | M2 |
| #135 服务器侧邮件轮询发送器 | M2 |
| #121 zxcvbn 前端强度计 / workerd PBKDF2 上限跟进 | M2 备忘 |
| #21 「邮箱凭据页」A2 占位 | M6 |
| #130 收官清理（探针 Worker×12、服务器 8465 实验配置回滚、临时文件） | 关单后运维动作 |
| #120 已暴露凭据统一轮换（CF token / SSH root / Stalwart API key 等） | 关单后运维动作 |

## 7. 验收资产

- D1 清理记录：`/tmp/unself-cleanup-prod-0914.md`（含逐表变更行数与终态计数）
- 邮件配置备份：`/tmp/mail-config-backup.json`（弱化形态切换前后恢复用，已恢复原值）
- 生产终态：users=1（admin）· invites/activations/notifications/audit 全 0 · Stalwart 账号 = admin/handy/no-reply（无测试孤儿）
