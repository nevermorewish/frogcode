# Claude Code 生态项目分析记忆

> 基于 2026-04-06 对 E:\Claude 下 7 个项目的深度分析

---

## 项目索引

| 项目 | 路径 | GitHub | 定位 |
|------|------|--------|------|
| opcode | E:\Claude\opcode | github.com/winfunc/opcode | Claude Code 桌面 GUI + Web |
| Any-code | E:\Claude\Any-code | github.com/anyme123/Any-code | 多 AI Agent 桌面 GUI |
| codexia | E:\Claude\codexia | github.com/milisp/codexia | 双 Agent 桌面 IDE |
| metabot | E:\Claude\metabot | github.com/xvirobotics/metabot | IM 多平台 Agent Bridge |
| happy | E:\Claude\happy | github.com/slopus/happy | 全平台加密 Claude 客户端 |
| cc-connect | E:\Claude\cc-connect | github.com/chenhg5/cc-connect | 多 Agent 多平台 Chat Bridge |
| nexu | E:\Claude\nexu | github.com/nexu-io/nexu | 桌面 AI Agent 网关 |

---

## Claude Code 连接方式

### 三大流派

**1. 原始子进程 spawn（单向读 stdout）**
- opcode, Any-code
- spawn `claude -p "..." --output-format stream-json`
- 逐行读取 stdout JSONL，解析 `{type:"system", subtype:"init"}` 获取 session_id
- 简单直接，但只能单向读取，不能回传权限响应

**2. Agent SDK**
- codexia: `claude-agent-sdk-rs`（Rust crate），SDK 内部 spawn 进程
- metabot: `@anthropic-ai/claude-agent-sdk`（Node），AsyncQueue 输入 + 异步流输出
- 双向交互，SDK hook 拦截工具调用，可 sendAnswer 回传
- codexia 的 SDK hook → 前端审批 → 回传；metabot 用 bypassPermissions

**3. Happy 三层模式（spawn + HTTP Hook + fd3）**
- happy 独创
- 通道1: stdio 继承（用户直接与 Claude 交互）
- 通道2: fd3 自定义管道（拦截 fetch 调用，驱动"思考中"状态）
- 通道3: HTTP Hook 服务器（Claude 通过 hook 脚本回报 session_id 等元数据）
- 最复杂但最完整，用户体验最接近原生 CLI

**4. stdin/stdout 双向 JSON 流**
- cc-connect（Go）
- `--input-format stream-json --output-format stream-json`
- stdin 写入 `{type:"user", message:{...}}` 和 `{type:"control_response", ...}`
- stdout 读取事件流，支持完整权限交互（6种模式）
- 是唯一真正实现 stdin 双向写入的项目

**5. 不直接连 Claude Code**
- nexu: 通过 WebSocket 连接 OpenClaw Gateway，Gateway 管理 Agent

---

## 各项目核心特征

### opcode (Rust/Tauri 2)
- 轻量 Claude Code GUI，Checkpoint 系统（Git 式快照 + fork）
- Web 模式：Axum + WebSocket，手机远程访问
- Usage Dashboard：按模型/日期/项目统计
- GitHub Agent 浏览器
- MCP 完整支持（stdio + SSE + 导入 Claude Desktop 配置）
- opcode-web.exe 前端资源用 rust-embed 嵌入（2026-04-06 修复了 404 问题）

### Any-code (Rust/Tauri 2)
- 支持 Claude Code + Codex + Gemini 三种 Agent
- Auto-compact 上下文：智能 token 监控 + 自动压缩
- 智能翻译中间件：8 种内容提取策略
- 消息回滚：撤回 prompt 自动回退
- 权限模式完整：Interactive / AcceptEdits / ReadOnly / Plan
- MCP 市场/模板

### codexia (Rust/Tauri 2)
- Claude Code（SDK）+ Codex 双 Agent
- P2P 远程控制：QUIC 隧道（桌面 + iOS 客户端）
- Cloudflare Tunnel 集成
- Cron 定时任务 + 执行历史
- 插件/技能系统 + 笔记系统
- 分析面板：贡献热力图、token 分解

### metabot (TypeScript/Node.js)
- 语音功能最完整：
  - STT: 豆包 Flash ASR + Whisper + 流式 WebSocket ASR
  - TTS: 豆包 + OpenAI + ElevenLabs + Edge（4 提供商）
  - RTC: 火山引擎实时语音通话 + 实时字幕 + 多 Bot 语音会议
- IM: 飞书（主力）+ Telegram + 微信
- Agent Bus: Bot 间通讯 `mb talk <bot> <chatId> "msg"`
- MetaSkill: 一键生成多 Agent 团队（编排者 + 专家 + 审查者）
- Peer Federation: 跨实例 Bot 发现与路由
- MetaMemory: SQLite 知识库 + 全文搜索
- 团队预算管理 + Prometheus + 熔断器
- 火山 RTC 需配置：VOLC_RTC_APP_ID, VOLC_RTC_APP_KEY, VOLC_ACCESS_KEY_ID, VOLC_SECRET_KEY

### happy (TypeScript/Node.js + Expo)
- 唯一支持 iOS + Android 移动端（Expo）
- 零知识加密：TweetNaCl + AES-256-GCM，服务器无法解密
- fd3 遥测管道独创
- 多设备同步：桌面/手机/Web 一键切换控制权
- 推送通知：权限请求/任务完成推送到手机
- Daemon 守护进程 + 设备配对
- 支持 Claude Code + Codex + Gemini + OpenClaw + ACP（5 种 Agent）
- Socket.IO WebSocket 通讯（happy-server）
- 语音：ElevenLabs 实时语音 + 语音 Agent

### cc-connect (Go)
- Agent 适配器最多：Claude Code / Codex / Cursor / Gemini / Qoder / OpenCode / iFlow（7 种）
- IM 平台最多：飞书/钉钉/Telegram/Slack/Discord/企微/LINE/QQ/微信（9 种）
- stdin/stdout 双向 JSON 流，权限模式最完整（6 种）
- Provider Proxy：本地反代改写第三方 API thinking 参数
- 自然语言 Cron + 目录切换 + 附件回传
- 多语言 i18n：中/英/日/西/繁体
- 语音：STT (OpenAI/Qwen) + TTS (OpenAI/Qwen/eSpeak)
- TOML 配置格式

### nexu (TypeScript/Electron + Hono)
- 零配置桌面网关，双击安装
- OpenClaw 控制平面，本地管理 Agent 生命周期
- 10+ IM 渠道开箱即用
- 多模型 BYOK：10+ 提供商一键切换
- Skill 热重载
- 本地优先，无订阅费
- 语音仅微信原生 STT（通过 WeChat voice_item.text）

---

## 关联项目

### happy-server (E:\Claude\happy\packages\happy-server)
- Fastify 框架，Socket.IO WebSocket 通讯
- 路径 /v1/updates，ping 15s / timeout 45s
- 3 种连接作用域：session-scoped / user-scoped / machine-scoped
- RPC 模式：rpc-register / rpc-call，30s 超时
- Token 认证，加密传输（AES + base64）

### nexu 通讯
- 不直接用 Claude Code CLI
- 作为 WebSocket 客户端连接 OpenClaw Gateway
- OpenClaw Protocol v3，JSON-RPC 帧（req/res/event）
- Ed25519 密钥对认证，30s 心跳，指数退避重连
- HTTP REST API (Hono + OpenAPI): /api/v1/bots, /health

---

## 技术栈汇总

| 项目 | 后端 | 桌面 | 前端 | 数据库 | 构建 |
|------|------|------|------|--------|------|
| opcode | Rust | Tauri 2 | React 18 | SQLite | Vite + bun |
| Any-code | Rust | Tauri 2 | React 18 | SQLite(WAL) | Vite + bun |
| codexia | Rust | Tauri 2 | React 19 | SQLite | Vite + bun |
| metabot | TypeScript | - | React 19 | SQLite | tsc |
| happy | TypeScript | Tauri 2(macOS) | React Native(Expo) | Postgres+SQLite | Vite+Expo+yarn |
| cc-connect | Go | - | React | - | Vite(Web)+pnpm |
| nexu | TypeScript | Electron | React 19+AntDesign | lowdb(JSON) | Vite+pnpm |

---

## 生成的文档

- E:\Claude\opcode\docs\claude-code-projects-comparison.md — Markdown 对比文档
- E:\Claude\claude-code-projects-comparison.html — HTML 可视化对比（含 GitHub 链接）
- E:\Claude\unified-platform-design.html — 统一平台架构设计 v3（Tauri 客户端 spawn + Server 管控 + Memory）
