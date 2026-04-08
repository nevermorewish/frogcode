pub mod acemcp;
pub mod auth;
pub mod claude;
pub mod home; // 首页工具检测
pub mod platform_bridge; // Platform 桥接 (Feishu 等 IM 通过 Node sidecar，多 CLI adapter)
pub mod clipboard;
pub mod codex; // OpenAI Codex integration
pub mod context_commands;
pub mod context_manager;
pub mod enhanced_hooks;
pub mod extensions;
pub mod file_operations;
pub mod gemini; // Google Gemini CLI integration
pub mod git_stats;
pub mod mcp;
pub mod permission_config;
pub mod prompt_tracker;
pub mod provider;
pub mod simple_git;
pub mod storage;
pub mod translator;
pub mod url_utils; // API URL 规范化工具
pub mod usage;
pub mod window; // 多窗口管理
pub mod wsl_utils; // WSL 兼容性工具
