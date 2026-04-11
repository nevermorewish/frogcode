# Frogcode Web 模式实现说明

> 在同一个 `src-tauri/` crate 里新增 `frogcode-web` 二进制,跑 Axum + WebSocket,
> 让浏览器/手机也能访问 frogcode,与桌面版共享同一份 Rust 执行逻辑。
>
> 参考方案:`E:\Claude\opcode` 的 web server,但从第一天就避开它的
> "cancel 是 stub" 和 "session 事件串线" 两个坑。

---

## 1. 目标与范围

### v1 已支持

- **Claude Code 会话** (execute / continue / resume / cancel)
- **项目 & 会话列表** / 历史加载
- **OpenClaw** (通过反向代理 + Tauri 命令 REST 化)
- **飞书 / Platform 配置** (与桌面版共享 `~/.anycode/` 下的配置文件)
- **Frogclaw 登录** (纯 HTTP 透传)

### v1 不支持

- Codex / Gemini 引擎 (Rust 命令还没抽 `_with_deps` 变体)
- MCP 服务器管理
- Windows 专属功能 (剪贴板、WSL、系统对话框等)
- 自动翻译中间件
- 认证 / TLS (只绑 `0.0.0.0` 内网无鉴权)
- WebSocket 断线自动重连

---

## 2. 架构

```
┌────────────────────┐                 ┌────────────────────────┐
│ Browser (React)    │                 │ frogcode-web (Rust)    │
│                    │  HTTP /api/*    │  ┌──────────────────┐  │
│ apiAdapter.ts      │ ◄─────────────► │  │ Axum Router      │  │
│  ├─ isTauri? ──────┤                 │  │  /api/projects   │  │
│  │  → 真 invoke   │                  │  │  /api/sessions/* │  │
│  └─ 否 → REST/WS ──┤                 │  │  /ws/exec        │  │
│                    │  WS /ws/exec    │  │  /api/openclaw/* │◄─┼─► Node sidecar HTTP
│ DOM CustomEvent    │ ◄═══════════════│  │  /api/platform/* │  │    (localhost, 外部)
│ (桥接 listen)     │                 │  └────────┬─────────┘  │
└────────────────────┘                 │  ┌────────▼─────────┐  │
                                       │  │ cli_runner.rs    │  │
                                       │  │ execute_*_deps   │  │   ← 与 Tauri 共享
                                       │  │ (EventSink API)  │  │
                                       │  └────────┬─────────┘  │
                                       │  ┌────────▼─────────┐  │
                                       │  │ ProcessRegistry  │  │   ← 纯 Rust,零改动
                                       │  └────────┬─────────┘  │
                                       └───────────┼────────────┘
                                                   ▼
                                            claude CLI 子进程
```

- **桌面** (`any-code.exe`):Tauri GUI,全部功能,使用 `TauriEventSink` 向
  `AppHandle.emit()` 发事件。
- **Web** (`frogcode-web.exe`):Axum HTTP + WS,Claude + OpenClaw 子集,
  使用 `WsEventSink` 向每个 WS 连接的 mpsc channel 发事件。
- 两边共用 `cli_runner.rs` 的 `execute_claude_code_with_deps` 等函数体。

---

## 3. 核心抽象:EventSink Trait

所有事件出口统一到 `src-tauri/src/process/event_sink.rs`:

```rust
pub trait EventSink: Send + Sync {
    fn emit_json(&self, event: &str, payload_json: String);
}

pub trait EventSinkExt: EventSink {
    fn emit<T: Serialize + ?Sized>(&self, event: &str, payload: &T) { ... }
}
impl<T: EventSink + ?Sized> EventSinkExt for T {}

pub struct TauriEventSink { handle: tauri::AppHandle }  // 桌面
pub struct WsEventSink    { tx: mpsc::Sender<String> } // web
pub struct NullEventSink;                              // 测试 / 空实现
pub type SharedEventSink = Arc<dyn EventSink>;
```

`WsEventSink::emit_json` 用 `try_send` 非阻塞下发,避免执行路径阻塞
在 channel 满;发送格式是 envelope:

```json
{ "event": "claude-output:abc", "payload": "..." }
```

前端 `apiAdapter.compatListen` 把这个 envelope 作为 DOM CustomEvent 派发
到 `window`,让 `listen()` 的调用方无感切换。

---

## 4. ClaudeSpawnDeps:依赖注入容器

`cli_runner.rs` 的核心函数 `spawn_claude_process_with_deps` 和
`execute_claude_code_with_deps` 不再接收 `AppHandle`,而是接收:

```rust
#[derive(Clone)]
pub struct ClaudeSpawnDeps {
    pub sink: SharedEventSink,
    pub registry: Arc<ProcessRegistry>,
    pub auto_compact: Option<Arc<AutoCompactManager>>,  // web 传 None
    pub current_process: Arc<Mutex<Option<Child>>>,
    pub last_spawned_pid: Arc<Mutex<Option<u32>>>,
}

impl ClaudeSpawnDeps {
    pub fn from_app(app: &AppHandle) -> Self { ... }  // 桌面构造
}
```

### ⚠ `ClaudeProcessState::Drop` 死锁陷阱

最初在 web 侧用 `ClaudeProcessState::default()` 构造一个临时值然后摘出它的
`Arc` 字段,结果 `Drop` 在函数末尾触发,其 `impl Drop` 里有
`handle.block_on(...)`,在 `#[tokio::main]` 运行时里直接 panic:

```
thread 'main' panicked at src\commands\claude\cli_runner.rs:83:20:
Cannot start a runtime from within a runtime.
```

**修复:** `WebAppState::new` 直接构造裸 `Arc::new(TokioMutex::new(None))`,
不要再走 `ClaudeProcessState::default()`,因为 `Drop` 在桌面模式下只在
app 退出时触发(运行时外),但 web 模式下会被创建/丢弃多次。

---

## 5. 路由表

### REST (Claude 会话)

| 方法 | 路径 | 映射的 Tauri command |
|---|---|---|
| GET | `/api/projects` | `list_projects` |
| GET | `/api/projects/{id}/sessions` | `get_project_sessions` |
| GET | `/api/sessions/{sid}/history/{pid}` | `load_session_history` |
| GET | `/api/sessions/running` | `list_running_claude_sessions` |
| POST | `/api/sessions/cancel` | `cancel_claude_execution` |
| GET | `/api/sessions/{sid}/output` | `get_claude_session_output` |

### WebSocket (流式执行)

`GET /ws/exec` 单连接多 session,消息格式:

```json
// 请求(前端→后端)
{ "command_type": "execute", "project_path": "...", "prompt": "...",
  "model": "sonnet", "session_id": null, "tab_id": "..." }

// 响应(后端→前端,envelope)
{ "event": "claude-output:abc123", "payload": "..." }
{ "event": "claude-output", "payload": { "tab_id": "...", "payload": "..." } }
{ "event": "claude-complete:abc123", "payload": true }
```

**避开 opcode 的坑**:
- 一个 WS 连接只开一个 mpsc channel,所有 session 通过 envelope 的
  `event` 字段区分(前端按 event 名分发)
- `session_id` 直接用前端传来的,不在后端重新生成 UUID → 会话事件
  天然 session-scoped
- Cancel 走 `ProcessRegistry.kill_process(run_id)`,和桌面版一个
  代码路径,零分支

### Platform / Feishu 配置 (与桌面共享 `~/.anycode/`)

| 方法 | 路径 | 映射 |
|---|---|---|
| GET / POST | `/api/platform/config` | `platform_get_config` / `platform_save_config` |
| GET / POST | `/api/platform/agent-config/{type}` | `platform_get_agent_config` / `platform_save_agent_config` |

### Platform sidecar 代理 (v2 新增)

Web 模式不能自己 spawn sidecar — 必须预先有一个 Node sidecar 在跑。
这些 REST 端点把 Tauri 的 `platform_*` 命令转换成对 `openclaw_base` 的
HTTP 调用:

| 方法 | 路径 | Sidecar 路径 | 说明 |
|---|---|---|---|
| POST | `/api/platform/start` | `GET /health` | 只查状态,不真正 spawn |
| POST | `/api/platform/stop` | *(no-op)* | sidecar 生命周期由桌面进程拥有 |
| GET | `/api/platform/status` | `GET /health` | 同 start |
| POST | `/api/platform/connect-feishu` | `POST /connect` | 触发飞书 WS 连接 |
| GET | `/api/platform/openclaw/status` | `GET /openclaw/status` | |
| POST | `/api/platform/openclaw/{start,stop,restart}` | 同名 | |
| GET | `/api/platform/openclaw/sessions` | `GET /openclaw/sessions` | |
| POST | `/api/platform/openclaw/session` | `GET /openclaw/sessions/{id}` | body `{id}` |

### OpenClaw 反向代理 (透明)

`/api/openclaw` 与 `/api/openclaw/{*rest}` 直接透传到 sidecar,
body / query / headers 原样转发,SSE 通过 `Body::from_stream` 对接
`reqwest` 的 stream response。

### Frogclaw 登录 (纯 HTTP 透传)

| 方法 | 路径 | Rust 命令 |
|---|---|---|
| POST | `/api/auth/login` | `login_to_frogclaw` |
| POST | `/api/auth/providers` | `fetch_frogclaw_providers` |

两个命令本来就只用 `reqwest` 调 `https://frogclaw.com`,无 `AppHandle` 依赖,
直接在 web handler 里 `await` Tauri 命令函数即可(`#[tauri::command]`
宏只是加了 Tauri 的调用包装,函数本体仍可直接调用)。

---

## 6. 前端 `apiAdapter.ts`

`src/lib/apiAdapter.ts` 是整个前端 web 化的唯一改动点:

```ts
export function isTauri(): boolean { ... }

// 透明的 invoke 替代品
export async function invoke<T>(cmd: string, args?): Promise<T> {
  if (isTauri()) return tauriInvoke<T>(cmd, args);
  if (isStreamingCommand(cmd)) { await dispatchStreaming(cmd, args); return; }
  const route = REST_ROUTES[cmd];
  if (route) return (await route(args)) as T;
  throw new Error(`[apiAdapter] command "${cmd}" is not available in web mode`);
}

// listen 兼容层
export async function compatListen<T>(event, handler): Promise<UnlistenFn> {
  if (isTauri()) return tauriListen(event, handler);
  const wrapped = (e: Event) => handler({ payload: (e as CustomEvent).detail });
  window.addEventListener(event, wrapped as EventListener);
  return () => window.removeEventListener(event, wrapped as EventListener);
}
```

### Import 切换清单

`src/lib/api.ts` 及所有直接 `import { listen } from '@tauri-apps/api/event'`
的文件改成从 `@/lib/apiAdapter` 取 `invoke` / `compatListen as listen`。
已切换的文件:

- `src/lib/api.ts`
- `src/hooks/usePromptExecution.ts`
- `src/hooks/useAutoCompactStatus.ts`
- `src/hooks/useGlobalEvents.ts`
- `src/hooks/usePlatformStatus.ts`
- `src/hooks/useSessionStream.ts`
- `src/hooks/useSessionSync.ts`
- `src/lib/stream/SessionConnection.ts`
- `src/components/layout/ViewRouter.tsx`
- `src/components/RunningClaudeSessions.tsx`

其他桌面专属命令 (win32 / 剪贴板 / 文件对话框) **继续用真 invoke**,
在 web 模式下会直接从 apiAdapter 抛 "not available in web mode" 错误,
UI 侧靠 feature flag 隐藏入口。

---

## 7. 飞书凭证:每个 Agent 独立 (Option B)

### 存储布局 (v5.29)

```
~/.anycode/platform-config.json          ← 只存 projectPath / enabled / agentType
~/.anycode/agents/claudecode.json        ← { binPath, ..., feishu: { appId, appSecret } }
~/.anycode/agents/openclaw.json          ← { binPath, ..., feishu: { appId, appSecret } }
```

### 读写路径

- `platform_bridge::read_config()`:读根文件拿 `agentType`,从
  `agents/{agentType}.json` 的 `feishu` 子对象取凭证,拼成完整 `FeishuConfig`
  返回给前端。
- `platform_bridge::write_config(cfg)`:把 `app_id/app_secret` 注入到
  `agents/{agentType}.json` 的 `feishu`,根文件只写 `projectPath/enabled/agentType`。
- 前端 wire 契约 `FeishuConfig { appId, appSecret, projectPath, enabled, agentType }`
  保持不变,读写由 Rust 在文件边界做合并/拆分。

### 遗留迁移

旧版本在 `platform-config.json` 根部存 `appId/appSecret`。
`read_config()` 检测到这种格式时:

1. 把凭证写到 `agents/{当前agentType}.json` 的 `feishu` 子对象
2. 重写根文件,剥掉 `appId`/`appSecret`/`app_id`/`app_secret` 字段
3. 记一条 info log:`Migrated legacy Feishu credentials from platform-config.json into agents/X.json`

如果目标 agent 文件已经有 `feishu` 凭证,不覆盖,只剥离根字段。

### Sidecar 侧 (`src-tauri/sidecar/platform/src/index.ts`)

`loadConfig()` 读根文件拿 `agentType`,然后从 `agents/${agentType}.json`
的 `feishu` 取凭证。根文件 `appId/appSecret` 作为遗留回退,保证旧安装
能正常启动直到下次写入触发 Rust 端迁移。

### UI (`src/components/im/FeishuSetupDialog.tsx`)

- 状态里持有 `credsByAgent: { claudecode, openclaw }`
- 打开对话框时 **并行** 读两个 agent 的配置,同时备份非凭证字段
  (`agentCfgRest`) 以免保存时丢掉 `binPath/stateDir/gatewayToken` 等
- 切换 "CLI Backend" 下拉立即切换 App ID / Secret 输入框的值(无需网络)
- 提交时分别保存每个 agent 的 `feishu.{appId, appSecret}`,再写根配置

---

## 8. 构建 & 运行

### package.json scripts

```json
"web:build":      "npm run build && cd src-tauri && cargo build --release --bin frogcode-web",
"web:build-fast": "npm run build && cd src-tauri && cargo build --profile dev-release --bin frogcode-web",
"web:run":        "npm run build && cd src-tauri && cargo run --bin frogcode-web"
```

### 编译

```bash
# web 版 release
npm run web:build

# 桌面版(必须带 custom-protocol feature,否则 release build 会尝试连 localhost:1420)
cd src-tauri && cargo build --release --bin any-code --features custom-protocol
```

### 启动

```bash
# 1) 先启动 sidecar(通过桌面版或手动)
#    桌面版方式:运行 any-code.exe,系统托盘会自动 spawn sidecar
#    手动方式:
node src-tauri/binaries/frogcode-platform-sidecar.cjs \
  --port 7890 \
  --config "%USERPROFILE%\.anycode\platform-config.json"

# 2) 启动 web 服务器,指向 sidecar
./src-tauri/target/release/frogcode-web.exe \
  --port 8080 \
  --openclaw-url http://127.0.0.1:7890

# 3) 浏览器打开
start http://localhost:8080
# 手机访问:ipconfig 查本机 IP,手机浏览器打开 http://<IP>:8080
```

### CLI 参数

```
frogcode-web [OPTIONS]

  -p, --port <PORT>              监听端口 [default: 8080]
  -H, --host <HOST>              绑定地址 [default: 0.0.0.0]
      --data-dir <PATH>          数据目录 [default: ~/.anycode]
      --openclaw-url <URL>       外部 Node sidecar 基址(没配则 platform_* 全报错)
```

---

## 9. 避坑记录

### 9.1 `dev-release` profile 在 Windows 编译 `windows-sys` 崩溃

```
error: could not compile `windows-sys` (lib) due to 2 previous errors
(exit code: 0xc0000005, STATUS_ACCESS_VIOLATION)
```

**根因:** `Cargo.toml` 里 `[profile.release.package."*"] opt-level = "z"`
和 dev-release 的 `codegen-units = 16` + thin LTO 组合触发 rustc 的
Windows 后端 bug。

**修复:** 用完整 `--release` profile (`opt-level = "z"` + `codegen-units = 1`)。
头几次编译慢(~4 分钟),deps 缓存后增量 ~50 秒。

### 9.2 `custom-protocol` feature 缺失导致桌面 release 连 localhost:1420

**症状:** 运行 release 版桌面应用显示 "无法访问此页面 localhost 拒绝连接"。

**根因:** Tauri 在 dev 模式下从 Vite dev server (port 1420) 加载资源,
release 模式必须启用 `custom-protocol` feature 才会从内嵌资源加载。

**修复:**
```bash
cargo build --release --bin any-code --features custom-protocol
```

### 9.3 `ClaudeProcessState::Drop` 死锁(已在 §4 描述)

### 9.4 rust_embed 找不到 `../dist`

必须在编译 `frogcode-web` 前先跑 `npm run build` 产出 `dist/`,
否则编译阶段 `#[derive(RustEmbed)]` 就会失败。已在 `package.json`
的 `web:build` script 里链式。

### 9.5 `frogcode-web.exe` 进程占用导致重新编译失败

```
error: failed to remove file `target\release\frogcode-web.exe`
Caused by: 拒绝访问。 (os error 5)
```

重编前先 `powershell -Command "Get-Process frogcode-web | Stop-Process -Force"`
或手动 Ctrl-C 终止。

### 9.6 SQLite 并发访问

桌面和 web 同时跑时两个进程都会打开 `agents.db`。已在
`commands/storage.rs::init_database` 加:

```rust
conn.busy_timeout(std::time::Duration::from_secs(5))?;
```

WAL 模式默认启用,并发读不会锁冲突。

---

## 10. 已知限制与未解决问题

### 10.1 ⚠ Web 模式 "保存配置 → 连接" 链路不会热更新 sidecar 配置

**现象:** 在 web 模式下修改飞书 App ID / App Secret 后点"连接":
- ✅ 文件已被 Rust 写入 `agents/{type}.json`
- ❌ sidecar 仍用它内存里的 `currentConfig`(旧凭证)去调 Lark SDK

**原因:** 桌面版通过 `platform_start` 重 spawn sidecar 进程来"重载"配置,
web 模式不能控制 sidecar 生命周期,`platform_start` 只是一个 `/health`
查询的 no-op。

**临时方案:** 改完配置后手动重启桌面版(触发桌面的 spawn 链路一次)。

**彻底方案(待做):**
1. 更新 sidecar 的 `POST /config` handler,让它支持新的拆分存储格式
   (`agents/{type}.json + platform-config.json`),不再写遗留的 flat 格式
2. 在 web 的 `rest_platform_save_config` handler 里,写文件后额外 POST 到
   `<openclaw_base>/config` 触发 sidecar 热重载
3. sidecar 的 `POST /config` 处理里,重新读取 `agents/{newAgent}.json` 的
   `feishu` 子对象,调 `initAgentManager` + 视情况 `disconnectFeishu`+`connectFeishu`

### 10.2 Sidecar 端口发现

桌面版启动 sidecar 时用的是 `--port 0` 动态端口,读首行 `FROGCODE_PLATFORM_READY port=NNN`
才知道实际端口。Web 版必须在启动时通过 `--openclaw-url` 手动传,无法自动发现。

**可选改进:** 让桌面版把当前 sidecar 端口写到
`~/.anycode/platform-sidecar.port` 文件,web 版启动时读取。

### 10.3 还没路由的 Tauri 命令

在 web 模式下调用以下命令会抛 `"not available in web mode"`:

- Codex / Gemini 相关的所有命令
- MCP 服务器管理 (`mcp_*`, `acemcp_*`)
- 剪贴板 / 文件对话框 / WSL (`clipboard_*`, `open_file_dialog`, `wsl_*`)
- 设置/安装相关 (`check_tools_installed`, `install_tool`, `list_claude_installations`)
- 翻译中间件相关
- 一些窗口管理 / 快捷键

UI 侧需要用 feature flag(`isTauri()`)隐藏这些入口,或者在 `apiAdapter`
里给它们返回空值让 UI 降级。

### 10.4 WebSocket 断线不自动重连

v1 不做,用户手动刷新页面即可。后续可以在 `apiAdapter.ExecWs` 里加指数
退避 + pending buffer 重放。

### 10.5 翻译中间件

前端的中文输入翻译走的是一条调用 Claude 本身的链路。web 模式下这条链路
在浏览器直连 Anthropic API 会有 CORS 问题。v1 先禁用,后续要把翻译中间件
后端化(放 Rust 侧)。

### 10.6 无认证

`0.0.0.0` 监听,任何能访问这个端口的客户端都能执行 Claude 命令、读会话
历史、改飞书配置。**只在受信任内网用**,对外暴露前必须做:

- Token / OAuth 鉴权
- TLS (反向代理或 axum 自己上 rustls)
- Per-session 的文件系统访问隔离

---

## 11. 文件清单

### 新建

| 路径 | 作用 |
|---|---|
| `src-tauri/src/process/event_sink.rs` | `EventSink` trait + Tauri/Ws/Null 三实现 |
| `src-tauri/src/web_server.rs` | Axum Router + REST/WS handler + sidecar 代理 |
| `src-tauri/src/web_main.rs` | clap CLI 入口 |
| `src/lib/apiAdapter.ts` | 前端环境探测 + REST/WS 路由 + listen 兼容层 |
| `docs/web-mode.md` | **本文档** |

### 主要修改

| 路径 | 改动 |
|---|---|
| `src-tauri/Cargo.toml` | 加 `axum/tower/tower-http/rust-embed/clap/async-trait` deps + `[[bin]] frogcode-web` target |
| `src-tauri/src/commands/claude/cli_runner.rs` | 拆 `*_with_deps` 函数体,所有 `app.emit` → `sink.emit` |
| `src-tauri/src/commands/claude/mod.rs` | 导出 `ClaudeSpawnDeps` + `*_with_deps` |
| `src-tauri/src/claude_binary.rs` | `find_claude_binary` 底层抽 `find_claude_binary_with_data_dir(&Path)` |
| `src-tauri/src/commands/claude/config.rs` | 去掉 `AppHandle` 依赖,抽 `load_claude_execution_config()` |
| `src-tauri/src/commands/storage.rs` | 加 `busy_timeout(5s)` |
| `src-tauri/src/commands/platform_bridge.rs` | 飞书凭证 Option B 拆分存储 + 遗留迁移 |
| `src-tauri/src/process/mod.rs` | 导出 `event_sink` |
| `src-tauri/sidecar/platform/src/index.ts` | `loadConfig` 从 `agents/{type}.json` 取凭证 |
| `src/lib/api.ts` | `import { invoke } from '@/lib/apiAdapter'` |
| `src/components/im/FeishuSetupDialog.tsx` | 每 agent 独立凭证表单 |
| `package.json` | 加 `web:build` / `web:build-fast` / `web:run` |

---

## 12. 回归 Checklist

### 桌面版(每次 Rust 改动后都跑)

- [ ] 启动 `npm run tauri:dev` 无 panic
- [ ] 新建 Claude 会话 → 发 prompt → 流式输出正常
- [ ] cost / token 计数更新
- [ ] 点取消按钮 → `claude-cancelled` 事件到达 + 子进程被杀
- [ ] 多 tab 并发执行互不串线
- [ ] resume 历史会话 + 继续执行正常
- [ ] 翻译中间件工作
- [ ] 飞书配置对话框加载已有凭证 (迁移生效)

### Web 版 冒烟

- [ ] `./frogcode-web.exe --port 8080` 日志看到 `🌐 frogcode-web listening`
- [ ] `http://localhost:8080` UI 正常加载
- [ ] 项目列表 / session 历史
- [ ] 发送 prompt → WebSocket envelope 流式到达 → UI 渲染
- [ ] 点取消 → `POST /api/sessions/cancel` 200 + 子进程被杀
- [ ] 两个 tab 并发执行,事件不串线
- [ ] 飞书配置对话框加载 → 切换 agent → 凭证切换
- [ ] Frogclaw 登录按钮不再报 `not available in web mode`
- [ ] OpenClaw 列表页面加载

### 手机访问

- [ ] `ipconfig` 查本机 IP
- [ ] 手机浏览器打开 `http://<IP>:8080`,跑一遍上面的冒烟
