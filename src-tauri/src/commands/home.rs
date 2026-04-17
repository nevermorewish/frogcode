use serde::Serialize;
use std::process::Command;
use std::io::Write;

#[derive(Debug, Clone, Serialize)]
pub struct ToolStatus {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub installable: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct HomeToolsStatus {
    pub tools: Vec<ToolStatus>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub message: String,
    pub log_file: Option<String>,
}

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Get the log file path: ~/.frogcode/install.log
fn get_log_path() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    let home = std::env::var("USERPROFILE").ok()?;
    #[cfg(not(target_os = "windows"))]
    let home = std::env::var("HOME").ok()?;
    let dir = std::path::PathBuf::from(home).join(".frogcode");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("install.log"))
}

fn write_log(msg: &str) {
    if let Some(path) = get_log_path() {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
            let _ = writeln!(f, "[{}] {}", ts, msg);
        }
    }
}

/// Ensure common Windows tool directories are in PATH for this process.
/// GUI apps often inherit a minimal PATH that lacks winget, npm, etc.
fn ensure_windows_path() {
    #[cfg(target_os = "windows")]
    {
        let current = std::env::var("PATH").unwrap_or_default();
        let mut extra: Vec<String> = Vec::new();

        // Common directories that may contain node/npm/winget
        if let Ok(local_app) = std::env::var("LOCALAPPDATA") {
            // WindowsApps (winget)
            let wa = format!("{}\\Microsoft\\WindowsApps", local_app);
            if !current.to_lowercase().contains(&wa.to_lowercase()) && std::path::Path::new(&wa).exists() {
                extra.push(wa);
            }
            // npm global
            let npm_prefix = format!("{}\\npm", local_app.replace("Local", "Roaming").replace("local", "Roaming"));
            if !current.to_lowercase().contains(&npm_prefix.to_lowercase()) && std::path::Path::new(&npm_prefix).exists() {
                extra.push(npm_prefix);
            }
        }

        if let Ok(pf) = std::env::var("ProgramFiles") {
            // nodejs
            let node = format!("{}\\nodejs", pf);
            if !current.to_lowercase().contains(&node.to_lowercase()) && std::path::Path::new(&node).exists() {
                extra.push(node);
            }
            // Git
            let git = format!("{}\\Git\\cmd", pf);
            if !current.to_lowercase().contains(&git.to_lowercase()) && std::path::Path::new(&git).exists() {
                extra.push(git);
            }
        }

        // fnm / nvm-windows
        if let Ok(home) = std::env::var("USERPROFILE") {
            // fnm
            let fnm = format!("{}\\.fnm", home);
            if !current.to_lowercase().contains(&fnm.to_lowercase()) && std::path::Path::new(&fnm).exists() {
                extra.push(fnm);
            }
            // nvm-windows
            let nvm = format!("{}\\AppData\\Roaming\\nvm", home);
            if !current.to_lowercase().contains(&nvm.to_lowercase()) && std::path::Path::new(&nvm).exists() {
                extra.push(nvm);
            }
        }

        // FNM_MULTISHELL_PATH (fnm creates a temp symlink dir)
        if let Ok(fnm_ms) = std::env::var("FNM_MULTISHELL_PATH") {
            if !current.to_lowercase().contains(&fnm_ms.to_lowercase()) && std::path::Path::new(&fnm_ms).exists() {
                extra.push(fnm_ms);
            }
        }

        // npm global prefix (dynamic, covers non-standard npm setups)
        if let Some(npm_dir) = npm_global_prefix() {
            if !current.to_lowercase().contains(&npm_dir.to_lowercase()) && std::path::Path::new(&npm_dir).exists() {
                extra.push(npm_dir);
            }
        }

        // nvm-windows symlink target (ProgramFiles\nodejs is created by nvm use)
        // Also check ProgramData\nvm (system-wide nvm install)
        for p in &["C:\\ProgramData\\nvm", "C:\\Program Files\\nodejs"] {
            if !current.to_lowercase().contains(&p.to_lowercase()) && std::path::Path::new(p).exists() {
                extra.push(p.to_string());
            }
        }

        if !extra.is_empty() {
            let new_path = format!("{};{}", extra.join(";"), current);
            std::env::set_var("PATH", &new_path);
            write_log(&format!("PATH extended with: {}", extra.join("; ")));
        }
    }
}

#[cfg(target_os = "windows")]
fn npm_global_prefix() -> Option<String> {
    use std::os::windows::process::CommandExt;
    let mut c = Command::new("cmd");
    c.args(&["/C", "npm", "prefix", "-g"]);
    c.creation_flags(CREATE_NO_WINDOW);
    c.output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(target_os = "windows")]
fn lookup_in_npm_prefix(cmd: &str) -> Option<String> {
    let prefix = npm_global_prefix()?;
    for ext in &[".cmd", ".ps1", ".exe", ""] {
        let p = format!("{}\\{}{}", prefix, cmd, ext);
        if std::path::Path::new(&p).exists() {
            return Some(p);
        }
    }
    None
}

fn run_lookup(cmd: &str) -> Option<String> {
    let lookup = if cfg!(target_os = "windows") { "where" } else { "which" };
    let mut c = Command::new(lookup);
    c.arg(cmd);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    let found = c.output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string()
        })
        .filter(|s| !s.is_empty());

    #[cfg(target_os = "windows")]
    {
        if found.is_some() {
            return found;
        }
        // Fallback: check npm global prefix directly (for npm-installed CLIs)
        return lookup_in_npm_prefix(cmd);
    }
    #[cfg(not(target_os = "windows"))]
    {
        found
    }
}

fn run_version(cmd: &str, args: &[&str]) -> Option<String> {
    let mut c = Command::new(cmd);
    for a in args {
        c.arg(a);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c.output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            let out = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if out.is_empty() {
                String::from_utf8_lossy(&o.stderr).trim().to_string()
            } else {
                out
            }
        })
        .filter(|s| !s.is_empty())
}

fn check_tool(id: &str, name: &str, cmd: &str, args: &[&str], installable: bool) -> ToolStatus {
    let path = run_lookup(cmd);
    // Use the resolved path for version check — bare command may fail in GUI processes
    let version = if let Some(ref p) = path {
        run_version(p, args).or_else(|| run_version(cmd, args))
    } else {
        None
    };
    write_log(&format!(
        "check_tool({}): path={:?}, version={:?}, installed={}",
        id, path, version, path.is_some()
    ));
    ToolStatus {
        id: id.to_string(),
        name: name.to_string(),
        installed: path.is_some(),
        version,
        path,
        installable,
    }
}

#[tauri::command]
pub async fn check_tools_installed() -> Result<HomeToolsStatus, String> {
    let tools = tokio::task::spawn_blocking(|| {
        ensure_windows_path();
        write_log("========== check_tools_installed ==========");
        write_log(&format!("PATH: {}", std::env::var("PATH").unwrap_or_default()));
        #[cfg(target_os = "windows")]
        {
            let prefix = npm_global_prefix();
            write_log(&format!("npm prefix -g: {:?}", prefix));
            for cmd in &["claude", "codex", "gemini"] {
                let via_where = run_lookup(cmd);
                write_log(&format!("lookup({}): {:?}", cmd, via_where));
            }
        }
        vec![
            check_tool("node", "Node.js", "node", &["--version"], true),
            check_tool("git", "Git", "git", &["--version"], true),
            check_tool("claude", "Claude Code", "claude", &["--version"], true),
            check_tool("codex", "Codex", "codex", &["--version"], true),
            check_tool("gemini", "Gemini CLI", "gemini", &["--version"], true),
            check_tool("openclaw", "OpenClaw", "openclaw", &["--version"], true),
        ]
    })
    .await
    .map_err(|e| format!("Failed to check tools: {}", e))?;

    Ok(HomeToolsStatus { tools })
}

/// Get the install command for a given tool id on the current platform.
/// Returns (program, args, requires_node).
fn get_install_command(tool_id: &str) -> Result<(String, Vec<String>, bool), String> {
    #[cfg(target_os = "windows")]
    {
        let has_winget = run_lookup("winget").is_some();
        match tool_id {
            "node" if has_winget => Ok((
                "winget".to_string(),
                vec![
                    "install".into(), "--id".into(), "OpenJS.NodeJS.LTS".into(),
                    "-e".into(), "--silent".into(),
                    "--accept-source-agreements".into(), "--accept-package-agreements".into(),
                ],
                false,
            )),
            "node" => {
                // Fallback: download Node.js LTS MSI from nodejs.org and install silently with msiexec.
                let arch = if cfg!(target_arch = "x86_64") { "x64" } else { "x86" };
                let ps_script = format!(
                    "$ErrorActionPreference='Stop'; \
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; \
$nodeVersion='25.9.0'; \
$arch='{}'; \
$url=\"https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-$arch.msi\"; \
$msi=Join-Path $env:TEMP \"node-v$nodeVersion-$arch.msi\"; \
Write-Host \"Downloading Node.js v$nodeVersion ($arch) from $url\"; \
Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing; \
$size=(Get-Item $msi).Length; \
Write-Host \"Downloaded $size bytes\"; \
Write-Host 'Installing Node.js via msiexec /qn ...'; \
$logFile=Join-Path $env:TEMP 'node-msi-install.log'; \
$p=Start-Process msiexec -ArgumentList '/i',\"`\"$msi`\"\",'/qn','/norestart','/L*v',\"`\"$logFile`\"\" -Wait -PassThru -NoNewWindow; \
if ($p.ExitCode -ne 0) {{ \
  $tail=if (Test-Path $logFile) {{ (Get-Content $logFile -Tail 30) -join \"`n\" }} else {{ '(no log)' }}; \
  throw \"msiexec exited with $($p.ExitCode). Log tail:`n$tail\" \
}}; \
Remove-Item $msi -Force -ErrorAction SilentlyContinue; \
$nodeDir='C:\\Program Files\\nodejs'; \
if (Test-Path $nodeDir) {{ \
  Write-Host \"Adding $nodeDir to user PATH\"; \
  $userPath=[Environment]::GetEnvironmentVariable('Path','User'); \
  if ($userPath -notlike \"*$nodeDir*\") {{ \
    [Environment]::SetEnvironmentVariable('Path',\"$userPath;$nodeDir\",'User') \
  }}; \
  $env:Path=\"$env:Path;$nodeDir\" \
}}; \
Write-Host 'Node.js installed successfully'",
                    arch
                );
                Ok((
                    "powershell".to_string(),
                    vec!["-NoProfile".into(), "-ExecutionPolicy".into(), "Bypass".into(), "-Command".into(), ps_script],
                    false,
                ))
            }
            "git" if has_winget => Ok((
                "winget".to_string(),
                vec![
                    "install".into(), "--id".into(), "Git.Git".into(),
                    "-e".into(), "--silent".into(),
                    "--accept-source-agreements".into(), "--accept-package-agreements".into(),
                ],
                false,
            )),
            "git" => {
                // Fallback: download Git for Windows installer from China mirrors (github.com is unreliable in CN).
                // Try npmmirror first, then tsinghua, then github as last resort.
                let arch = if cfg!(target_arch = "x86_64") { "64-bit" } else { "32-bit" };
                let ver = "2.47.1";
                let ps_script = format!(
                    "$ErrorActionPreference='Stop'; \
                     [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; \
                     $arch='{arch}'; $ver='{ver}'; \
                     $urls=@( \
                       \"https://npmmirror.com/mirrors/git-for-windows/v$ver.windows.1/Git-$ver-$arch.exe\", \
                       \"https://mirrors.tuna.tsinghua.edu.cn/github-release/git-for-windows/git/Git%20for%20Windows%20$ver/Git-$ver-$arch.exe\", \
                       \"https://github.com/git-for-windows/git/releases/download/v$ver.windows.1/Git-$ver-$arch.exe\" \
                     ); \
                     $exe=Join-Path $env:TEMP 'git-installer.exe'; \
                     $ok=$false; $lastErr=''; \
                     foreach ($url in $urls) {{ \
                       try {{ \
                         Write-Host \"Trying $url\"; \
                         Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing -TimeoutSec 60; \
                         if ((Get-Item $exe).Length -gt 1000000) {{ $ok=$true; Write-Host \"Downloaded from $url\"; break }} \
                       }} catch {{ $lastErr=$_.Exception.Message; Write-Host \"Failed: $lastErr\" }} \
                     }}; \
                     if (-not $ok) {{ throw \"All mirrors failed. Last error: $lastErr\" }}; \
                     Write-Host 'Installing Git (silent)...'; \
                     $p=Start-Process $exe -ArgumentList '/VERYSILENT','/NORESTART','/NOCANCEL','/SP-','/SUPPRESSMSGBOXES' -Wait -PassThru -NoNewWindow; \
                     if ($p.ExitCode -ne 0) {{ throw \"Git installer exited with $($p.ExitCode)\" }}; \
                     $gitPath=if ($arch -eq '64-bit') {{ 'C:\\Program Files\\Git\\cmd' }} else {{ 'C:\\Program Files (x86)\\Git\\cmd' }}; \
                     if (Test-Path $gitPath) {{ $env:Path+=\";$gitPath\" }}; \
                     Remove-Item $exe -Force -ErrorAction SilentlyContinue; \
                     Write-Host 'Git installed successfully'"
                );
                Ok((
                    "powershell".to_string(),
                    vec!["-NoProfile".into(), "-ExecutionPolicy".into(), "Bypass".into(), "-Command".into(), ps_script],
                    false,
                ))
            }
            "claude" => Ok((
                "cmd".to_string(),
                vec!["/C".into(), "npm".into(), "install".into(), "-g".into(), "@anthropic-ai/claude-code".into(), "--registry".into(), "https://registry.npmmirror.com".into()],
                true,
            )),
            "codex" => Ok((
                "cmd".to_string(),
                vec!["/C".into(), "npm".into(), "install".into(), "-g".into(), "@openai/codex".into(), "--registry".into(), "https://registry.npmmirror.com".into()],
                true,
            )),
            "gemini" => Ok((
                "cmd".to_string(),
                vec!["/C".into(), "npm".into(), "install".into(), "-g".into(), "@google/gemini-cli".into(), "--registry".into(), "https://registry.npmmirror.com".into()],
                true,
            )),
            "openclaw" => Ok((
                "cmd".to_string(),
                vec!["/C".into(), "npm".into(), "install".into(), "-g".into(), "openclaw@latest".into(), "--registry".into(), "https://registry.npmmirror.com".into()],
                true,
            )),
            _ => Err(format!("Unknown tool id: {}", tool_id)),
        }
    }
    #[cfg(target_os = "macos")]
    {
        match tool_id {
            "node" => Ok(("brew".to_string(), vec!["install".into(), "node".into()], false)),
            "git" => Ok(("brew".to_string(), vec!["install".into(), "git".into()], false)),
            "claude" => Ok(("npm".to_string(), vec!["install".into(), "-g".into(), "@anthropic-ai/claude-code".into(), "--registry".into(), "https://registry.npmmirror.com".into()], true)),
            "codex" => Ok(("npm".to_string(), vec!["install".into(), "-g".into(), "@openai/codex".into(), "--registry".into(), "https://registry.npmmirror.com".into()], true)),
            "gemini" => Ok(("npm".to_string(), vec!["install".into(), "-g".into(), "@google/gemini-cli".into(), "--registry".into(), "https://registry.npmmirror.com".into()], true)),
            "openclaw" => Ok(("npm".to_string(), vec!["install".into(), "-g".into(), "openclaw@latest".into(), "--registry".into(), "https://registry.npmmirror.com".into()], true)),
            _ => Err(format!("Unknown tool id: {}", tool_id)),
        }
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        match tool_id {
            "node" => Ok(("sh".to_string(), vec!["-c".into(), "sudo apt-get install -y nodejs npm || sudo dnf install -y nodejs npm".into()], false)),
            "git" => Ok(("sh".to_string(), vec!["-c".into(), "sudo apt-get install -y git || sudo dnf install -y git".into()], false)),
            "claude" => Ok(("npm".to_string(), vec!["install".into(), "-g".into(), "@anthropic-ai/claude-code".into(), "--registry".into(), "https://registry.npmmirror.com".into()], true)),
            "codex" => Ok(("npm".to_string(), vec!["install".into(), "-g".into(), "@openai/codex".into(), "--registry".into(), "https://registry.npmmirror.com".into()], true)),
            "gemini" => Ok(("npm".to_string(), vec!["install".into(), "-g".into(), "@google/gemini-cli".into(), "--registry".into(), "https://registry.npmmirror.com".into()], true)),
            "openclaw" => Ok(("npm".to_string(), vec!["install".into(), "-g".into(), "openclaw@latest".into(), "--registry".into(), "https://registry.npmmirror.com".into()], true)),
            _ => Err(format!("Unknown tool id: {}", tool_id)),
        }
    }
}

#[tauri::command]
pub async fn install_tool(tool_id: String) -> Result<InstallResult, String> {
    let id = tool_id.clone();
    tokio::task::spawn_blocking(move || {
        ensure_windows_path();

        let log_file = get_log_path().map(|p| p.to_string_lossy().to_string());
        write_log(&format!("========== Installing tool: {} ==========", id));
        write_log(&format!("Current PATH: {}", std::env::var("PATH").unwrap_or_default()));

        let (program, args, requires_node) = get_install_command(&id)?;
        write_log(&format!("Command: {} {}", program, args.join(" ")));

        // For npm-based installs, ensure node is present.
        if requires_node {
            let node_path = run_lookup("node");
            write_log(&format!("Node lookup result: {:?}", node_path));
            if node_path.is_none() {
                let msg = "需要先安装 Node.js 才能安装此工具".to_string();
                write_log(&format!("FAILED: {}", msg));
                return Ok(InstallResult {
                    success: false,
                    stdout: String::new(),
                    stderr: String::new(),
                    message: msg,
                    log_file,
                });
            }
        }

        // Ensure the installer program itself exists.
        let prog_path = run_lookup(&program);
        write_log(&format!("{} lookup result: {:?}", program, prog_path));
        if prog_path.is_none() {
            let msg = if program == "brew" {
                format!(
                    "未找到 Homebrew 包管理器。请先安装 Homebrew:\n\n/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"\n\n或访问 https://brew.sh 查看安装说明"
                )
            } else {
                format!("未找到安装程序 \"{}\"，请先手动安装", program)
            };
            write_log(&format!("FAILED: {}", msg));
            return Ok(InstallResult {
                success: false,
                stdout: String::new(),
                stderr: String::new(),
                message: msg,
                log_file,
            });
        }

        let mut c = Command::new(&program);
        for a in &args {
            c.arg(a);
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(CREATE_NO_WINDOW);
        }

        match c.output() {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                let success = out.status.success();

                write_log(&format!("Exit code: {:?}", out.status.code()));
                if !stdout.trim().is_empty() { write_log(&format!("STDOUT:\n{}", stdout.trim())); }
                if !stderr.trim().is_empty() { write_log(&format!("STDERR:\n{}", stderr.trim())); }

                let message = if success {
                    format!("{} 安装成功", id)
                } else {
                    // Include stderr snippet in message for user visibility
                    let err_hint = stderr.lines().take(3).collect::<Vec<_>>().join(" | ");
                    format!("{} 安装失败 (exit {}): {}", id, out.status.code().unwrap_or(-1), err_hint)
                };
                write_log(&format!("Result: {}", message));
                Ok(InstallResult { success, stdout, stderr, message, log_file })
            }
            Err(e) => {
                let msg = format!("执行安装命令失败: {}", e);
                write_log(&format!("FAILED: {}", msg));
                Ok(InstallResult {
                    success: false,
                    stdout: String::new(),
                    stderr: String::new(),
                    message: msg,
                    log_file,
                })
            }
        }
    })
    .await
    .map_err(|e| format!("Failed to spawn install task: {}", e))?
}
