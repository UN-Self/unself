# AI 接入能力调研

> 来源：docs/PRODUCT_SPEC.md v3（2026-09-10）§11；落地里程碑见 docs/roadmap.md（M4）。

## 两种协议：WebMCP vs 经典 MCP（关键区分）

| | WebMCP（EdgeChat 已接入） | 经典 MCP（本地 agent 主流） |
|---|---|---|
| 形态 | 页面在 ChatGPT 桌面版内置浏览器里打开时，通过 `document.modelContext.registerTool` 注册站点工具 | 独立服务进程（stdio/HTTP/SSE），agent 客户端主动连接 |
| 支持方 | OpenAI Codex/ChatGPT Work（实验标准）；社区桥接 `chgold/webmcp-client` 可接 Claude Desktop | Claude Desktop、Cursor、Copilot、自定义本地 agent 等全部支持 |
| EdgeChat 现状 | ✅ 已实现，注册 5 个工具：`edgechat.login / list_channels / read_messages / send_message / open_dm`（frontend/src/webmcp.ts，261 行） | ❌ 无现成 MCP server，也无 CLI（源码确认：仅 webmcp.ts + Telegram 桥） |

## 本地 agent 接入方案（基于源码调研）

EdgeChat 有完整 REST API（`/api/auth/login`、`/api/messages`、`/api/messages/read`、`/api/ws/...` 实时票券等），**写一个 200 行左右的 MCP server 包装这些端点即可让任意本地 agent 读写聊天**。

| 接入方式 | 工作量 | 适用 |
|---|---|---|
| 用现成 WebMCP（ChatGPT/Codex 浏览器） | 零 | 你在 ChatGPT 桌面版里操作聊天 |
| 社区桥接（webmcp-client）接 Claude Desktop | 低 | 用 Claude Desktop |
| **自建 MCP server（包装 EdgeChat REST API）** | 小（~200 行） | 任意本地 agent（Claude/Cursor/自写 agent/手机端 agent） |
| **统一平台 MCP server（聊天+日历+邮件+看板）** | 中（一个服务全模块） | 终极形态：本地 agent 像管理员一样操作整个平台 |

## Workers AI 平台推理（另一件事）

| 能力 | CF 方案 | 说明 |
|---|---|---|
| 对话助手（IM 机器人） | Workers AI（Llama/DeepSeek-R1-Distill 等） | 边缘推理，免费 10K neurons/天，超了按量几分钱 |
| 文档/消息检索问答（RAG） | Workers AI 嵌入 + Vectorize（向量库） | 对自家 md 文档/消息做知识库 |
| 会议纪要/语音转写 | Workers AI Whisper | 录音→文字→摘要 |
| 外部模型接入 | Worker 内直连 OpenAI/DeepSeek 等 API | 本地模型不够时做路由 |

**建议**：
- 本地 agent 接入：优先用 EdgeChat 现成 WebMCP（零成本）；需要 Claude/Cursor 等时再写 MCP server 包装层；统一平台 MCP 放 M5 之后
- 平台内 AI：首版两个最小落地——①IM 机器人（@AI 问答）②会议录音转写
