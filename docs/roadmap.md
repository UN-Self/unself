# 路线图

当前怎么部署看 [deploy.md](deploy.md)。模块怎么拿资源看 [flows.md](flows.md)。要什么看 [requirements.md](requirements.md)。验收记录只写在对应的 issue 或 PR 里，不写进这份文件。

## 已经在仓库里

- 平台：安装器把 core 和 workbench 部署到 Cloudflare。另一条路是 Docker 拉起 workbench。安装器不装模块。
- 模块：都是 npm 包，用 `npm pack` 打包。Cloudflare 上由工作台部署成 Worker；也可以自己用 Docker 跑同一个包。
- 聊天：`app/modules/chat`（`@unself/chat`）。频道消息、附件、已读回执在这个模块里。代码从 EdgeChat 搬来，许可证是 GPL-3.0，不打进核心。
- hello 模块、工作台壳、邀请和登录、可选的邮件通知。

## 还没有

- Git Webhook 进工作台
- 日历、会议、文档、看板
- 聊天里的 @ 提醒已验收（2026-11-21）；历史检索还没单独立项验收
- PWA、多级审批、全局搜索
- 成员停用后立刻踢掉已经发出的模块 token。现在只靠 token 过期

顺序按 [requirements.md](requirements.md) 里还没勾上的项。不在这里再排一套里程碑编号。

## Cloudflare 免费层（10 人量级，账户额度，不是按人计）

数字是当时查的免费层，变了以 Cloudflare 当时的文档为准。

| 资源 | 免费层量级 | 判断 |
|---|---|---|
| Workers 请求 | 10 万/天 | 够用 |
| Durable Objects | 10 万请求/天；休眠不计时长 | 够用 |
| D1 | 单库 500MB，写 10 万行/天 | 够用。单库快满了再拆 |
| R2 | 存储 10GB，出流量免费 | 够用。满了用自己的桶 |
| Workers AI | 1 万 neurons/天 | 最容易先触顶 |

AI 超了再考虑 Workers 付费。文件满了换模块 env 里自己的存储，不另做一层适配器。
