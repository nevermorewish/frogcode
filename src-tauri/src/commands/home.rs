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
    /// True when the tool is installed but its version is below what downstream
    /// tooling requires (e.g. Node < 22.14 breaks openclaw). Frontend shows a
    /// "reinstall" CTA so the user can upgrade in place.
    pub needs_upgrade: bool,
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

/// openclaw's `package.json` declares `engines.node >= 22.14.0` and the
/// runtime hard-rejects anything < v22.12. Pin to (major, minor) so we can
/// reuse this in pre-install validation and version-based install fallback.
const MIN_NODE_FOR_OPENCLAW: (u32, u32) = (22, 14);

/// Linux Node bootstrap. Downloads Node 22 LTS tarball from Tsinghua mirror
/// (npmmirror + nodejs.org as fallbacks) and overlay-installs into /usr/local.
/// `apt-get install nodejs` on current LTS distros gives Node 18-20, which is
/// too old for openclaw and modern claude-code.
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
const NODE_INSTALL_SCRIPT_LINUX: &str = r#"set -e
VER=22.16.0
ARCH=linux-x64
TARBALL=node-v$VER-$ARCH.tar.xz
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
echo "Downloading Node v$VER..."
ok=0
for url in \
  "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/v$VER/$TARBALL" \
  "https://npmmirror.com/mirrors/node/v$VER/$TARBALL" \
  "https://nodejs.org/dist/v$VER/$TARBALL" ; do
  echo "  try: $url"
  if curl -fSL --connect-timeout 20 --retry 2 -o "$TARBALL" "$url"; then
    ok=1; break
  fi
done
[ "$ok" = "1" ] || { echo "all Node mirrors failed" >&2; exit 1; }
echo "Extracting..."
tar -xJf "$TARBALL"
DIR=node-v$VER-$ARCH
if [ "$(id -u)" = "0" ]; then S=""; else S="sudo"; fi
$S mkdir -p /usr/local/bin /usr/local/lib /usr/local/include /usr/local/share
$S cp -rf "$DIR/bin/." /usr/local/bin/
$S cp -rf "$DIR/lib/." /usr/local/lib/
$S cp -rf "$DIR/include/." /usr/local/include/ 2>/dev/null || true
$S cp -rf "$DIR/share/." /usr/local/share/ 2>/dev/null || true
hash -r
/usr/local/bin/node -v
/usr/local/bin/npm -v
echo "Node v$VER installed to /usr/local"
"#;

/// Parse a Node version string ("v22.18.0" or "22.18.0") into (major, minor).
fn parse_node_version(s: &str) -> Option<(u32, u32)> {
    let s = s.trim().trim_start_matches('v');
    let mut it = s.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next()?.parse().ok()?;
    Some((major, minor))
}

/// Detect the currently-installed Node version as `(major, minor)`.
/// Returns None if node is absent or the output cannot be parsed.
fn detect_node_version() -> Option<(u32, u32)> {
    let path = run_lookup("node")?;
    let version = run_version(&path, &["--version"])?;
    parse_node_version(&version)
}

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

/// Extend PATH on Unix so GUI-launched processes can find node/npm/git
/// installed under nvm, n, fnm, conda, Homebrew, /usr/local, etc. Desktop
/// launchers and AppImages usually don't source the user's shell rc files.
#[cfg(not(target_os = "windows"))]
fn ensure_unix_path() {
    let current = std::env::var("PATH").unwrap_or_default();
    let has = |p: &str| current.split(':').any(|s| s == p);

    let mut extra: Vec<String> = Vec::new();
    let mut push = |p: String| {
        if !p.is_empty() && std::path::Path::new(&p).is_dir() && !extra.contains(&p) {
            extra.push(p);
        }
    };

    // System / Homebrew / core locations first — stable absolute paths.
    for p in &[
        "/usr/local/bin",
        "/opt/homebrew/bin",      // macOS apple-silicon brew
        "/home/linuxbrew/.linuxbrew/bin",
        "/usr/bin",
        "/bin",
        "/snap/bin",
        "/opt/conda/bin",
    ] {
        if !has(p) { push((*p).to_string()); }
    }

    if let Ok(home) = std::env::var("HOME") {
        // nvm: ~/.nvm/versions/node/*/bin — pick every installed version's bin
        let nvm_versions = std::path::PathBuf::from(&home).join(".nvm/versions/node");
        if let Ok(rd) = std::fs::read_dir(&nvm_versions) {
            for entry in rd.flatten() {
                let bin = entry.path().join("bin");
                if bin.is_dir() {
                    push(bin.to_string_lossy().to_string());
                }
            }
        }
        // n (mklement0/n-install) puts things under ~/n
        push(format!("{}/n/bin", home));
        // fnm multishell directory
        if let Ok(fnm_ms) = std::env::var("FNM_MULTISHELL_PATH") {
            push(format!("{}/bin", fnm_ms));
        }
        // conda in user home
        push(format!("{}/miniconda3/bin", home));
        push(format!("{}/anaconda3/bin", home));
        // npm global prefix (user installs)
        push(format!("{}/.npm-global/bin", home));
        push(format!("{}/.local/bin", home));
    }

    // npm prefix -g (authoritative for user-configured npm global)
    if let Some(np) = unix_npm_global_prefix() {
        let bin = format!("{}/bin", np.trim_end_matches('/'));
        push(bin);
    }

    if !extra.is_empty() {
        let new_path = if current.is_empty() {
            extra.join(":")
        } else {
            format!("{}:{}", extra.join(":"), current)
        };
        std::env::set_var("PATH", &new_path);
        write_log(&format!("PATH extended with: {}", extra.join(":")));
    }
}

#[cfg(not(target_os = "windows"))]
fn unix_npm_global_prefix() -> Option<String> {
    // Try each existing node binary we can find — npm may live next to it.
    for candidate in ["npm", "/usr/local/bin/npm", "/usr/bin/npm"] {
        let out = Command::new(candidate).arg("prefix").arg("-g").output().ok();
        if let Some(o) = out {
            if o.status.success() {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if !s.is_empty() { return Some(s); }
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn is_reparse_point(p: &std::path::Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    std::fs::symlink_metadata(p)
        .map(|m| m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
        .unwrap_or(false)
}

/// Walk PATH + PATHEXT manually. Orders of magnitude faster than `where.exe`
/// on systems with large PATH, and avoids picking up App Execution Aliases
/// (zero-byte reparse points in WindowsApps) that hang when executed.
#[cfg(target_os = "windows")]
fn lookup_in_path_windows(cmd: &str) -> Option<String> {
    if cmd.contains('\\') || cmd.contains('/') {
        let p = std::path::Path::new(cmd);
        if p.is_file() && !is_reparse_point(p) {
            return Some(p.to_string_lossy().to_string());
        }
        return None;
    }
    let path_var = std::env::var("PATH").unwrap_or_default();
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let exts: Vec<&str> = pathext.split(';').filter(|s| !s.is_empty()).collect();

    for dir in path_var.split(';').filter(|s| !s.is_empty()) {
        let bare = std::path::Path::new(dir).join(cmd);
        if bare.is_file() && !is_reparse_point(&bare) {
            return Some(bare.to_string_lossy().to_string());
        }
        for ext in &exts {
            let candidate = std::path::Path::new(dir).join(format!("{}{}", cmd, ext));
            if candidate.is_file() && !is_reparse_point(&candidate) {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn npm_global_prefix() -> Option<String> {
    // Skip the cmd subprocess entirely when npm isn't resolvable — on systems
    // without node/npm, `cmd /C npm prefix -g` can hang ~30s before failing.
    lookup_in_path_windows("npm")?;
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

#[cfg(not(target_os = "windows"))]
fn lookup_in_path(cmd: &str) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    // If cmd is already an absolute / relative path, check it directly.
    if cmd.contains('/') {
        let p = std::path::Path::new(cmd);
        if p.is_file() {
            return Some(p.to_string_lossy().to_string());
        }
        return None;
    }
    let path_var = std::env::var("PATH").unwrap_or_default();
    for dir in path_var.split(':').filter(|s| !s.is_empty()) {
        let candidate = std::path::Path::new(dir).join(cmd);
        if let Ok(meta) = std::fs::metadata(&candidate) {
            if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    // Last-resort: well-known locations for core shell utilities that
    // may exist even when PATH is stripped (e.g. some GUI-launched processes).
    for p in &["/bin", "/usr/bin", "/usr/local/bin", "/sbin", "/usr/sbin"] {
        let candidate = std::path::Path::new(p).join(cmd);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

fn run_lookup(cmd: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        // Manual PATH walk first — fast, no subprocess, skips App Execution
        // Aliases. We deliberately avoid `where.exe`: on systems with large
        // PATH it can take 5-7s per call, and matches in WindowsApps cause
        // the subsequent `--version` to launch the Microsoft Store.
        if let Some(p) = lookup_in_path_windows(cmd) {
            return Some(p);
        }
        return lookup_in_npm_prefix(cmd);
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Same approach on Unix: manual walk first (handles minimal images
        // that ship without `which`), then fall back to `which` for any
        // exotic resolution it might still cover.
        if let Some(p) = lookup_in_path(cmd) {
            return Some(p);
        }
        let mut c = Command::new("which");
        c.arg(cmd);
        c.output()
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
            .filter(|s| !s.is_empty())
    }
}

fn run_version(cmd: &str, args: &[&str]) -> Option<String> {
    // Run with a hard timeout so a misbehaving binary (e.g. one that prompts
    // on first launch) can't stall detection indefinitely.
    use std::sync::mpsc;
    use std::time::Duration;

    let cmd = cmd.to_string();
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut c = Command::new(&cmd);
        for a in &args { c.arg(a); }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(CREATE_NO_WINDOW);
        }
        let result = c.output().ok()
            .filter(|o| o.status.success())
            .map(|o| {
                let out = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if out.is_empty() {
                    String::from_utf8_lossy(&o.stderr).trim().to_string()
                } else {
                    out
                }
            })
            .filter(|s| !s.is_empty());
        let _ = tx.send(result);
    });
    rx.recv_timeout(Duration::from_secs(5)).ok().flatten()
}

fn check_tool(id: &str, name: &str, cmd: &str, args: &[&str], installable: bool) -> ToolStatus {
    let path = run_lookup(cmd);
    // Use the resolved path for version check — bare command may fail in GUI processes
    let version = if let Some(ref p) = path {
        run_version(p, args).or_else(|| run_version(cmd, args))
    } else {
        None
    };
    let installed = path.is_some();
    let needs_upgrade = if id == "node" && installed {
        version
            .as_deref()
            .and_then(parse_node_version)
            .map(|v| v < MIN_NODE_FOR_OPENCLAW)
            .unwrap_or(false)
    } else {
        false
    };
    write_log(&format!(
        "check_tool({}): path={:?}, version={:?}, installed={}, needs_upgrade={}",
        id, path, version, installed, needs_upgrade
    ));
    ToolStatus {
        id: id.to_string(),
        name: name.to_string(),
        installed,
        version,
        path,
        installable,
        needs_upgrade,
    }
}

#[tauri::command]
pub async fn check_tools_installed() -> Result<HomeToolsStatus, String> {
    // PATH setup must complete before any parallel lookups see it.
    tokio::task::spawn_blocking(|| {
        ensure_windows_path();
        #[cfg(not(target_os = "windows"))]
        ensure_unix_path();
        write_log("========== check_tools_installed ==========");
        write_log(&format!("PATH: {}", std::env::var("PATH").unwrap_or_default()));
    })
    .await
    .map_err(|e| format!("Failed to prepare env: {}", e))?;

    // Check all tools concurrently — each check spawns subprocesses that can
    // block for seconds on Windows, so serial runs easily exceed 30s.
    let specs: &[(&str, &str, &str)] = &[
        ("node", "Node.js", "node"),
        ("git", "Git", "git"),
        ("claude", "Claude Code", "claude"),
        ("codex", "Codex", "codex"),
        ("gemini", "Gemini CLI", "gemini"),
        ("openclaw", "OpenClaw", "openclaw"),
    ];

    let mut handles = Vec::with_capacity(specs.len());
    for (id, name, cmd) in specs {
        let id = id.to_string();
        let name = name.to_string();
        let cmd = cmd.to_string();
        handles.push(tokio::task::spawn_blocking(move || {
            check_tool(&id, &name, &cmd, &["--version"], true)
        }));
    }

    let mut tools = Vec::with_capacity(handles.len());
    for h in handles {
        tools.push(h.await.map_err(|e| format!("Failed to check tool: {}", e))?);
    }

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
            "node" => {
                // 优先使用 brew，如果没有则使用 n-install 安装到用户目录（无需 sudo）
                if run_lookup("brew").is_some() {
                    Ok(("brew".to_string(), vec!["install".into(), "node".into()], false))
                } else {
                    // 使用 n-install 脚本安装 n 和 Node.js LTS 到 ~/n，无需 sudo
                    Ok(("sh".to_string(), vec![
                        "-c".into(),
                        "curl -fsSL https://raw.githubusercontent.com/mklement0/n-install/stable/bin/n-install | bash -s -- -y lts && export N_PREFIX=\"$HOME/n\" && export PATH=\"$N_PREFIX/bin:$PATH\"".into()
                    ], false))
                }
            },
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
            "node" => {
                // Distro packages (`apt-get install nodejs`) ship Node 18-20 on
                // current LTS releases — too old for openclaw (>=22.14) and
                // claude-code. Fetch a known-good Node 22 LTS tarball directly
                // from Tsinghua mirror (most reliable from CN) with fallbacks,
                // then overlay-install into /usr/local. Uses sudo only when
                // not already root.
                let script = NODE_INSTALL_SCRIPT_LINUX.to_string();
                Ok(("sh".to_string(), vec!["-c".into(), script], false))
            }
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
        #[cfg(not(target_os = "windows"))]
        ensure_unix_path();

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
                #[cfg(target_os = "macos")]
                let msg = "需要先安装 Node.js 才能安装此工具。如果您刚安装了 Node.js，请重启应用后再试".to_string();
                #[cfg(not(target_os = "macos"))]
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

            // openclaw has a hard runtime check for Node >= 22.12 (its
            // package.json declares >=22.14). Installing with an older node
            // only to fail at first launch wastes a multi-minute npm install
            // and leaves a broken binary — refuse up front.
            if id == "openclaw" {
                let detected = detect_node_version();
                let (need_maj, need_min) = MIN_NODE_FOR_OPENCLAW;
                let ok = detected.map(|v| v >= MIN_NODE_FOR_OPENCLAW).unwrap_or(false);
                if !ok {
                    let cur = detected
                        .map(|(a, b)| format!("v{}.{}", a, b))
                        .unwrap_or_else(|| "unknown".into());
                    let msg = format!(
                        "openclaw 需要 Node.js v{}.{}+，当前为 {}。请先升级 Node.js（可在本页重新安装 Node.js 自动升级到受支持版本）",
                        need_maj, need_min, cur
                    );
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

        // Use the absolute path we resolved via run_lookup so the OS doesn't
        // need to do its own PATH search. Avoids ENAMETOOLONG (os error 36)
        // on Linux when PATH/env vars in conda+cuda environments push glibc's
        // execvp past PATH_MAX while expanding entries.
        let spawn_target = prog_path.as_deref().unwrap_or(program.as_str());
        write_log(&format!("Spawning: {}", spawn_target));
        let mut c = Command::new(spawn_target);
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
                    if id == "node" {
                        #[cfg(target_os = "macos")]
                        {
                            if run_lookup("brew").is_none() {
                                format!("{} 安装成功。请重启应用以使 Node.js 生效", id)
                            } else {
                                format!("{} 安装成功", id)
                            }
                        }
                        #[cfg(not(target_os = "macos"))]
                        {
                            format!("{} 安装成功", id)
                        }
                    } else {
                        format!("{} 安装成功", id)
                    }
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
