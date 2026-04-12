# Frog Code

> 专业的 AI 代码助手桌面应用 — 多引擎、飞书 IM 集成、现代化 GUI 工具包

[![Release](https://img.shields.io/github/v/release/nevermorewish/frogcode?style=flat-square)](https://github.com/nevermorewish/frogcode/releases)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg?style=flat-square)](https://github.com/nevermorewish/frogcode)
[![Made with Tauri](https://img.shields.io/badge/Made%20with-Tauri-FFC131?style=flat-square&logo=tauri)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react)](https://react.dev/)
[![Rust](https://img.shields.io/badge/Rust-Latest-orange?style=flat-square&logo=rust)](https://rust-lang.org/)

---

## 简介

Frog Code 是一个为 AI 驱动的代码开发工作流量身打造的专业桌面应用。支持 [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/overview)、[OpenAI Codex](https://openai.com/index/openai-codex/)、[Google Gemini CLI](https://github.com/google-gemini/gemini-cli) 和 [OpenClaw](https://openclaw.com/) 四大 AI 后端。通过飞书 IM 集成，可以直接在飞书中与 AI 编程助手对话。

### 核心亮点

- **多引擎架构** — Claude Code、OpenAI Codex、Google Gemini、OpenClaw，一键切换
- **飞书 IM 集成** — 在飞书中直接与 AI 对话，支持流式卡片更新和交互按钮
- **多机器人支持** — 可添加多个飞书机器人，每个通道独立分配 AI 后端
- **Frogclaw 服务器** — 登录后自动获取 API 令牌、OpenClaw 配置和飞书凭据
- **OpenClaw 网关** — 内置进程管理、自动启动、会话历史浏览器、日志查看器
- **完整的会话管理** — 多标签页会话、历史记录、实时流式输出、跨引擎统一管理
- **成本追踪** — 多模型定价、Token 统计、使用分析仪表板
- **智能翻译中间件** — 中英文透明翻译，8 种内容提取策略
- **自动上下文管理** — 智能监控、自动压缩、Token 优化
- **现代化 UI/UX** — 深色/浅色主题、流畅动画、响应式设计、国际化支持

---

## 三步快速上手

### 第一步：安装开发环境

启动 Frog Code 后，首页会自动检测所需工具的安装情况。点击 **一键安装** 补全缺少的工具：

| 工具 | 用途 |
|------|------|
| Node.js | Sidecar 进程运行时 |
| Git | 版本控制 |
| Claude Code | 官方 Claude CLI（需要 Claude Max 订阅） |
| OpenClaw | AI 网关（通过 Frogclaw 服务器） |

### 第二步：登录 Frogclaw

在首页输入 Frogclaw 用户名和密码。登录成功后，应用会自动：
- 获取 API 令牌用于身份验证
- 下载 OpenClaw 模型配置
- 将飞书 App 凭据同步到 IM 通道设置中

### 第三步：配置飞书通道

进入 **IM 通道** 页面：
1. 点击 **添加通道**，填写飞书机器人的 App ID 和 App Secret
2. 通过下拉框为通道选择 AI 后端：
   - **Claude Code** — 使用官方 Claude Max 订阅
   - **OpenClaw** — 通过 Frogclaw 服务器路由，可配置模型
3. 分配后端后飞书机器人自动连接。在飞书中发送消息即可开始 AI 对话编程！

> 支持添加多个飞书机器人。每种后端同一时间只能绑定一个通道，切换时自动解绑原通道。

---

## AI 引擎

<table>
<tr>
<td width="25%">

**Claude Code CLI**
- 官方 Claude Code CLI 完整集成
- 支持所有 Claude 模型（Opus、Sonnet 等）
- Plan Mode 只读分析模式
- 完整的 MCP 和工具调用支持
- 智能 Hooks 自动化系统

</td>
<td width="25%">

**OpenAI Codex**
- Codex API 深度集成
- Full Auto / Danger Full Access / Read-only 三种模式
- 可配置模型和输出 Schema
- JSON 格式流式输出

</td>
<td width="25%">

**Google Gemini**
- Gemini CLI 完整集成
- Gemini 3 Pro、2.5 Pro/Flash
- Google OAuth / API Key / Vertex AI
- 百万级上下文窗口

</td>
<td width="25%">

**OpenClaw**
- AI 网关
- 可配置模型路由
- 内置进程管理
- 支持随应用自动启动
- 会话历史浏览器

</td>
</tr>
</table>

---

## 飞书 IM 集成

平台桥接层通过 Node.js Sidecar 将飞书消息连接到 AI 后端：

```
飞书机器人  -->  Platform Sidecar  -->  Claude Code CLI / OpenClaw 网关
                      |
                  流式卡片更新（代码块 + 交互按钮）
```

**主要功能：**
- 实时流式响应，渲染为飞书消息卡片
- 多机器人支持，每个通道独立分配后端
- 配置凭据后随应用启动自动连接
- 会话持久化存储在 `~/.frogcode/openclaw/agents/*/sessions/`

**OpenClaw Sessions 页面：**
- 双栏浏览器：左侧会话列表 + 右侧消息详情
- 网关状态横幅（Start/Stop/Restart 控制按钮）
- 可折叠的网关日志查看器
- 支持从磁盘导入历史会话

---

## 核心特性

### 会话管理
- 多标签页会话，支持拖拽排序
- 实时 Markdown 流式渲染，代码高亮
- Continue / Resume / Cancel 控制
- 消息撤回和提示词回滚
- 跨引擎统一会话列表

### 成本追踪
- 多模型定价（Opus、Sonnet 等）
- Cache 读写分离计费
- 按会话和按项目分析
- 使用仪表板（日期趋势、导出报告）

### 开发者工具
- **MCP 集成** — 添加/管理 MCP 服务器，从 Claude Desktop 导入，内置市场
- **Claude 扩展** — Plugins、Subagents、Agent Skills 查看器
- **Hooks 自动化** — 提交前审查、安全扫描、自定义 Hook 链
- **代码上下文搜索** — 基于 Acemcp 的语义搜索和自动索引

### 翻译中间件
- 中英文透明翻译
- 8 种内容提取策略
- 渐进式翻译，优先级队列
- 翻译缓存，MD5 去重

### 自动上下文管理
- 实时 Token 使用量监控
- 自动触发上下文压缩
- 压缩历史记录和统计
- 可配置的保留策略

---

## 安装

### 预构建版本（推荐）

从 [Releases](https://github.com/nevermorewish/frogcode/releases) 下载：

| 平台 | 格式 | 自动更新 |
|------|------|----------|
| **Windows** | NSIS 安装包 (.exe)、免安装版 (.exe) | 仅安装版 |
| **macOS** | DMG（ARM + Intel） | 支持 |
| **Linux** | AppImage、DEB、RPM | 仅 AppImage |

<details>
<summary><b>macOS Gatekeeper 修复</b></summary>

如果 macOS 提示应用"已损坏"或"无法验证开发者"：

```bash
sudo xattr -r -d com.apple.quarantine "/Applications/Frog Code.app"
```

</details>

### 从源码构建

```bash
# 克隆仓库
git clone https://github.com/nevermorewish/frogcode.git
cd frogcode

# 安装依赖
npm install

# 开发模式（热重载）
npm run tauri:dev

# 生产构建
npm run tauri:build

# 快速构建（dev-release 配置）
npm run tauri:build-fast
```

**构建要求：** Node.js 18+、Rust 1.70+、平台工具链（Windows 需要 WebView2、Linux 需要 webkit2gtk）

---

## 技术架构

```
┌─────────────────────┬─────────────────┬───────────────────────┐
│   React 前端层      │   Tauri 桥接层   │   Rust 后端层         │
│                     │                 │                       │
│ - React 18 + TS     │ - IPC 通信      │ - 多引擎管理          │
│ - Tailwind CSS 4    │ - 类型安全      │ - 进程管理            │
│ - Radix UI          │ - 事件流        │ - SQLite 存储         │
│ - Framer Motion     │                 │ - MCP 管理            │
│ - i18next           │                 │ - 翻译服务            │
└─────────────────────┴─────────────────┴───────────────────────┘
         │                                        │
         └──────── IPC 事件流 ────────────────────┘
                          │
    ┌─────────────┬───────┴───────┬──────────────┐
    │ Claude CLI  │ OpenAI Codex  │ Gemini CLI   │
    └─────────────┴───────────────┴──────────────┘

    Platform Sidecar (Node.js)
    ├── Agent Manager（Claude Code / OpenClaw 适配器）
    ├── 飞书卡片渲染器（流式更新）
    └── OpenClaw 网关（进程管理 + WebSocket）
```

### 技术栈

| 层级 | 技术 |
|------|------|
| **前端** | React 18、TypeScript 5.9、Tailwind CSS 4、Radix UI、Framer Motion、i18next |
| **后端** | Tauri 2.9、Rust 2021、Tokio、rusqlite、reqwest、serde |
| **Sidecar** | Node.js、TypeScript、Axum（Web 模式）、WebSocket |
| **构建** | Vite 6、cargo、GitHub Actions CI/CD |

### 数据存储

| 数据 | 位置 |
|------|------|
| 会话数据 | `~/.claude/projects/`（JSONL） |
| 应用设置 | `~/.frogcode/`（JSON 配置） |
| 平台配置 | `~/.frogcode/platform-config.json` |
| 代理配置 | `~/.frogcode/agents/{type}.json` |
| IM 通道 | `~/.frogcode/im-channels.json` |
| OpenClaw 状态 | `~/.frogcode/openclaw/state/` |
| 翻译缓存 | SQLite（Rust 后端管理） |

---

## 配置说明

### 平台配置 (`~/.frogcode/platform-config.json`)

```json
{
  "projectPath": "~/.openclaw/workspace",
  "enabled": true,
  "agentType": "openclaw",
  "openclawAutoStart": true
}
```

### MCP 服务器配置

```json
{
  "acemcp": {
    "transport": "stdio",
    "command": "acemcp",
    "args": [],
    "env": { "ACEMCP_PROJECT_ROOT": "/path/to/project" }
  }
}
```

### Gemini 配置 (`~/.frogcode/gemini/config.json`)

```json
{
  "authMethod": "google_oauth",
  "defaultModel": "gemini-2.5-pro",
  "approvalMode": "auto_edit"
}
```

---

## 更新日志

### v1.0.2 (2026-04)

- 首页三步引导流程，带完成状态指示
- 首页 OpenClaw 启动按钮和运行状态指示器
- OpenClaw 自动启动勾选框（持久化到平台配置）
- IM 通道页面使用说明
- OpenClaw Sessions 页面使用引导
- Frogclaw 登录时自动同步飞书凭据到 IM 通道
- 修复 updater 签名 strip 问题

### v1.0.1 (2026-04)

- 全局品牌重命名：Any Code -> Frog Code
- 首次启动自动安装 OpenClaw 默认技能和插件
- 飞书会话默认工作目录 `~/.openclaw/workspace`
- 更新自动更新 endpoint 和 pubkey
- CI：Node.js 24 兼容、GitHub Actions v5

### 历史版本

<details>
<summary><b>v5.x（重命名前）</b></summary>

- v5.6.6：Google Gemini 引擎，三引擎架构
- v4.4.0：OpenAI Codex 集成、翻译增强、自动上下文管理
- v4.0.1：Claude 扩展管理器、MCP 市场、成本追踪

</details>

---

## 贡献指南

```bash
# Fork 并克隆
git clone https://github.com/YOUR_USERNAME/frogcode.git
cd frogcode

# 安装依赖并开发
npm install
npm run tauri:dev

# 提交规范
# feat: / fix: / docs: / refactor: / perf: / chore:
```

---

## 故障排除

<details>
<summary><b>应用无法启动</b></summary>

1. 检查 Claude Code CLI：`claude --version`
2. Windows：确保已安装 WebView2 Runtime
3. 查看日志：`%APPDATA%/frog-code/logs`（Windows）/ `~/Library/Application Support/frog-code/logs`（macOS）

</details>

<details>
<summary><b>飞书机器人不响应</b></summary>

1. 检查 IM 通道页面 — 确保通道已分配后端（不是"未分配"）
2. 确认平台 Sidecar 正在运行（首页第一步绿色状态）
3. 检查飞书 App ID 和 App Secret 是否正确
4. 查看系统日志页面获取详细错误信息

</details>

<details>
<summary><b>OpenClaw 网关无法启动</b></summary>

1. 检查 OpenClaw 是否已安装（首页开发环境检测）
2. 确认端口 18789 未被占用
3. 查看 OpenClaw Sessions 页面状态横幅的错误详情
4. 展开网关日志面板查看详细日志

</details>

---

## 许可证

**AGPL-3.0** — 详见 [LICENSE](LICENSE) 文件。

---

## 相关链接

- [Claude Code 官方文档](https://docs.claude.com/en/docs/claude-code/overview)
- [Google Gemini CLI](https://github.com/google-gemini/gemini-cli)
- [Tauri 框架](https://tauri.app/)
- [MCP 协议](https://modelcontextprotocol.io/)

---

<div align="center">

**Frog Code** — 多引擎 AI 桌面应用，飞书 IM 集成

[GitHub](https://github.com/nevermorewish/frogcode) | [下载](https://github.com/nevermorewish/frogcode/releases)

</div>
