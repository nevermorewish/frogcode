# Windows libuv Assertion 崩溃 — 待修复

**状态**：未解决，待明天处理
**记录时间**：2026-04-23
**影响**：Windows 下每次发普通 prompt，Claude 进程在响应前后的某个时刻硬崩，会话失败

---

## 症状

`~/.frogcode/session-management.log` 每次发消息都看到这种循环：

```
[ui info:tab] created tab-... type=new project=- activate=true
[rust info:cli] spawned Claude pid=Some(16344)
[rust info:cli] Claude exited success=false code=Some(-1073740791)
```

stderr 同时打：

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
```

退出码 `-1073740791` = `0xC0000409` = Windows `STATUS_STACK_BUFFER_OVERRUN` —— 实际是 MSVC CRT 在 `assert()` 失败后调 `__fastfail()` 的退出码。**Claude 自己的 Node 进程在 libuv 里崩**，不是 frogcode 的 Rust 代码崩。

## 已知上游 Issue

- [anthropics/claude-code#7579](https://github.com/anthropics/claude-code/issues/7579) — Windows 上 `claude mcp list` 同样断言，2025-09 报告，未修
- 同类型 libuv 旧 bug：[joyent/libuv#1278](https://github.com/joyent/libuv/issues/1278)（句柄复用 race）、[libuv#505](https://github.com/libuv/libuv/issues/505)（pipe 多次 write 断言）

## 已排除的因素

| 假设 | 验证方法 | 结论 |
|---|---|---|
| MCP server 触发（#7579 主因） | 用户确认未配 MCP server | ❌ 不是 |
| LSP 插件触发（gopls / rust-analyzer） | 把 `enabledPlugins` 清空，仍崩 | ❌ 不是 |
| 缺 `DISABLE_TELEMETRY` / `DISABLE_AUTOUPDATER` 等环境变量 | 已加（`cli_runner.rs::create_command_with_env`），仍崩 | ❌ 不是（已排除） |
| Claude CLI 版本太老 | 用户已是 `2.1.111`，npm 上最新只有 `2.1.117`，差 6 个 patch | 几乎不可能这个差距修了底层 libuv |
| api key 交互菜单 | A+B 已修（`apiKeyHelper` 自动注入）；本次没看到该菜单 | ❌ 不是 |

## 真凶定位

**最可能**：frogcode 当前 spawn 模型是 **"每条 prompt 起新 Claude → 写 stdin → 立刻关 stdin → 等输出 → Claude 自然退出"**。这个 **"写 + 立刻 shutdown stdin"** 在 Windows 上特别容易触发 libuv 的 close-handle race —— Claude 退出时 libuv 同时在收尾 pipe handle 和 async handle，时序乱掉就 `assert(!UV_HANDLE_CLOSING)` 失败。

证据：
- 我们 spawn 用 `tokio::process::Command` + `stdio::piped()`（`cli_runner.rs:297-299`）
- prompt 写入：`stdin.write_all(...)` 后立刻 `stdin.shutdown().await`（`cli_runner.rs:884-893` 附近）
- 走 `--output-format stream-json` 但**没有** `--input-format stream-json`，所以 Claude 进入"读一个 prompt → 输出完就退出"的一次性模式

PTY 通道（`/login` 等命令走的那条）目前**不会**崩（用户只在 stream-json 通道看到崩溃），佐证了"普通 stdin pipe 关闭时机"是问题源。

## 明天的修复方案

### 方案 A — 最小验证（10 分钟）

只动 stdin 关闭时机，不改协议：

**位置**：`src-tauri/src/commands/claude/cli_runner.rs::spawn_claude_process_with_deps`，找到 `stdin.shutdown().await` 那一段（约 884-893 行附近）。

**改动**：把 `stdin.shutdown().await` 删掉，让 stdin 在 tokio 的下一次 GC 时自然关闭，错开 libuv 的 close 窗口。或者写完 prompt 后 `tokio::time::sleep(Duration::from_millis(200))` 再 drop。

**验证**：跑 `npm run tauri:dev`，发 5-10 条普通 prompt，看 session-management.log 还有没有 `code=Some(-1073740791)`。

**预期**：有 50% 概率缓解（race window 错开），不一定根治。

### 方案 B — 长连接 stream-json（半天-1 天，根治）

把 spawn 模型改成 **"一个 Claude 进程跨多轮 prompt 复用"**，stdin 永远不主动关闭。

**改动 1**：`src-tauri/src/commands/permission_config.rs::build_execution_args` 加：
```rust
args.push("--input-format".to_string());
args.push("stream-json".to_string());
```

**改动 2**：`cli_runner.rs::spawn_claude_process_with_deps` 重写 stdin 处理：
- 不再 `write_all + shutdown`
- 把 prompt 包装成一行 JSONL：
  ```json
  {"type":"user","message":{"role":"user","content":[{"type":"text","text":"<prompt>"}]}}
  ```
- 写完留 `\n`，**stdin 不关闭**
- 把 stdin 的 writer 半边存到 `ProcessRegistry` 里（类似 PTY 的 `pty_handles` 表）

**改动 3**：新增 Tauri 命令 `send_prompt_to_session(session_id, prompt)`：
- 从 registry 拿到该 session 的活 stdin writer
- 写一行 JSONL prompt
- Claude 不退出，继续吐 stream-json 响应到现有事件流

**改动 4**：`src/hooks/usePromptExecution.ts` 改路由：
- 如果当前 tab 已经有活 session（`session_id` 已经从 init 消息拿到）→ 调 `send_prompt_to_session`
- 如果没有 → 调原来的 `executeClaudeCode`（首次 spawn）

**改动 5**：cancel 路径：
- 关 stdin 时先 sleep 200ms 再 drop（同方案 A 的 stdin 关闭技巧）
- 或者发个 `{"type":"cancel"}` 让 Claude 自己退（如果支持）

**改动 6**：会话结束时（用户关 tab）才真正 kill Claude 进程。

**验证**：除了发 prompt 不崩，还要确认：
- 多轮 prompt 在同一个 Claude 进程里正常工作
- 切 tab / 关 tab 不会泄漏进程
- cancel 干净退出
- token 计费 / 翻译 / Plan 模式 没回归

## 实施建议

1. **先做方案 A** — 10 分钟，看效果。如果消失就交付。
2. **不行就上方案 B** —— 是 IDE/CLI wrapper 的"标准做法"（claudecodeui 的 SDK 模式、metabot 的 Agent SDK 模式都是常驻），值得做。

## 参考代码位置

- 当前 spawn 入口：`src-tauri/src/commands/claude/cli_runner.rs:319` `execute_claude_code`
- 共享 spawn 实现：`src-tauri/src/commands/claude/cli_runner.rs:859` `spawn_claude_process_with_deps`
- stdin 写入 + shutdown：`src-tauri/src/commands/claude/cli_runner.rs:875-895` 附近
- Args 构建：`src-tauri/src/commands/permission_config.rs:164` `build_execution_args`
- Registry：`src-tauri/src/process/registry.rs`，已有 PTY 的 `pty_handles` side-table 模式可抄给 stdin
- 已有 PTY 通道：`src-tauri/src/commands/claude/pty_runner.rs`（参考 child + handle 生命周期管理）

## 已经做了/不要重做

- ✅ A+B `apiKeyHelper` 自动注入（`provider.rs::ensure_api_key_helper_for_spawn`）
- ✅ 5 个 `DISABLE_*` 环境变量已经加到 `cli_runner.rs::create_command_with_env`，无需重加
- ✅ PTY 双通道 + 黑名单（`/login` 等走 PTY）已工作
- ✅ session-management.log 埋点完整，明天调试直接看这个日志
- ⚠️ 别再去试"升级 Claude CLI 到 150+"，那个版本号是我编的，实际最新就 2.1.117

## 临时绕开（用户当前可用的 workaround）

走 PTY 模式 —— 在会话头部点"终端模式"按钮（如果还没加按钮，把任何 prompt 包一层 `/help` 之类的黑名单命令也能强制走 PTY，但不实用）。PTY 通道**不**触发本断言。
