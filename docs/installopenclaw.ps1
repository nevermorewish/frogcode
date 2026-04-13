<# OpenClaw Chinese Edition Installer (Windows PowerShell) #>
<# Usage: iwr -useb https://clawd.org.cn/install.ps1 | iex #>
<# Usage with registry: .\install.ps1 -Registry https://registry.npmmirror.com #>

param(
    [string]$Version,
    [switch]$Beta,
    [string]$Registry,
    [switch]$NoOnboard,
    [switch]$NoPrompt,
    [switch]$DryRun,
    [switch]$Verbose,
    [switch]$Help
)

# Do NOT use "Stop" - it causes the script to exit immediately on any error
$ErrorActionPreference = "Continue"

# Set UTF-8 encoding for Chinese characters in moltbot-cn output
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
    # Set code page to UTF-8
    chcp 65001 | Out-Null
} catch {
    # Ignore errors
}

# Colors
$AccentColor = "DarkYellow"
$InfoColor = "Yellow"
$SuccessColor = "Green"
$WarnColor = "DarkYellow"
$ErrorColor = "Red"
$MutedColor = "DarkGray"

# Show help
if ($Help) {
    Write-Host ""
    Write-Host "OpenClaw Chinese Edition Installer" -ForegroundColor $AccentColor
    Write-Host ""
    Write-Host "Usage:" -ForegroundColor $InfoColor
    Write-Host "  iwr -useb https://clawd.org.cn/install.ps1 | iex"
    Write-Host "  .\install.ps1 [options]"
    Write-Host ""
    Write-Host "Options:" -ForegroundColor $InfoColor
    Write-Host "  -Version <version>    npm install version (default: latest)"
    Write-Host "  -Beta                 Use beta version (if available)"
    Write-Host "  -Registry <url>       npm registry (default: https://registry.npmjs.org)"
    Write-Host "  -NoOnboard            Skip onboarding (non-interactive)"
    Write-Host "  -NoPrompt             Disable prompts (required for CI/automation)"
    Write-Host "  -DryRun               Print what would be done (no changes)"
    Write-Host "  -Verbose              Print debug output"
    Write-Host "  -Help                 Show this help"
    Write-Host ""
    Write-Host "Examples:" -ForegroundColor $InfoColor
    Write-Host "  iwr -useb https://clawd.org.cn/install.ps1 | iex"
    Write-Host "  .\install.ps1 -Registry https://registry.npmmirror.com"
    Write-Host "  .\install.ps1 -Version 1.0.0 -NoOnboard"
    Write-Host ""
    exit 0
}

# Config - CLI args override env vars
$script:NoOnboard = $NoOnboard -or ($env:CLAWDBOT_NO_ONBOARD -eq "1")
$script:NoPrompt = $NoPrompt -or ($env:CLAWDBOT_NO_PROMPT -eq "1")
$script:DryRun = $DryRun -or ($env:CLAWDBOT_DRY_RUN -eq "1")
$OpenclawVersion = if ($Version) { $Version } elseif ($env:CLAWDBOT_VERSION) { $env:CLAWDBOT_VERSION } else { "latest" }
$NpmRegistry = if ($Registry) { $Registry } elseif ($env:CLAWDBOT_NPM_REGISTRY) { $env:CLAWDBOT_NPM_REGISTRY } else { "https://registry.npmjs.org" }
$UseBeta = $Beta -or ($env:CLAWDBOT_BETA -eq "1")
$script:Verbose = $Verbose -or ($env:CLAWDBOT_VERBOSE -eq "1")

# Refresh PATH in current session
function Refresh-Path {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}

# Banner
Write-Host ""
Write-Host "  ======================================" -ForegroundColor $AccentColor
Write-Host "       OpenClaw Chinese Edition" -ForegroundColor $AccentColor
Write-Host "  ======================================" -ForegroundColor $AccentColor
Write-Host ""

# Detect OS
Write-Host "[OK] Windows detected" -ForegroundColor $SuccessColor

# Check Node.js
function Test-NodeInstalled {
    $nodeVersion = $null
    try {
        $nodeVersion = & node -v 2>&1
    } catch {
        # Ignore
    }
    
    if ($nodeVersion -and $nodeVersion -match '^v\d+') {
        $majorVersion = 0
        if ($nodeVersion -match 'v(\d+)') {
            $majorVersion = [int]$Matches[1]
        }
        if ($majorVersion -ge 22) {
            Write-Host "[OK] Node.js $nodeVersion installed" -ForegroundColor $SuccessColor
            return $true
        } else {
            Write-Host "[!] Node.js $nodeVersion installed, but v22+ required" -ForegroundColor $WarnColor
            return $false
        }
    } else {
        Write-Host "[!] Node.js not found" -ForegroundColor $WarnColor
        return $false
    }
}

# Install Node.js
function Install-NodeJS {
    Write-Host "[*] Installing Node.js..." -ForegroundColor $InfoColor
    
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "  Using winget..." -ForegroundColor $MutedColor
        if ($DryRun) {
            Write-Host "  [dry-run] winget install OpenJS.NodeJS.LTS" -ForegroundColor $MutedColor
        } else {
            & winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
            Refresh-Path
        }
        Write-Host "[OK] Node.js installed via winget" -ForegroundColor $SuccessColor
        return $true
    }
    
    if (Get-Command choco -ErrorAction SilentlyContinue) {
        Write-Host "  Using Chocolatey..." -ForegroundColor $MutedColor
        if ($DryRun) {
            Write-Host "  [dry-run] choco install nodejs-lts -y" -ForegroundColor $MutedColor
        } else {
            & choco install nodejs-lts -y
            Refresh-Path
        }
        Write-Host "[OK] Node.js installed via Chocolatey" -ForegroundColor $SuccessColor
        return $true
    }
    
    if (Get-Command scoop -ErrorAction SilentlyContinue) {
        Write-Host "  Using Scoop..." -ForegroundColor $MutedColor
        if ($DryRun) {
            Write-Host "  [dry-run] scoop install nodejs-lts" -ForegroundColor $MutedColor
        } else {
            & scoop install nodejs-lts
            Refresh-Path
        }
        Write-Host "[OK] Node.js installed via Scoop" -ForegroundColor $SuccessColor
        return $true
    }
    
    Write-Host ""
    Write-Host "ERROR: Cannot auto-install Node.js" -ForegroundColor $ErrorColor
    Write-Host ""
    Write-Host "Please install Node.js 22+ manually:" -ForegroundColor $InfoColor
    Write-Host "  https://nodejs.org/en/download/" -ForegroundColor $AccentColor
    Write-Host ""
    return $false
}

# Check and install Node.js
if (-not (Test-NodeInstalled)) {
    if ($NoPrompt) {
        if (-not (Install-NodeJS)) {
            exit 1
        }
    } else {
        Write-Host ""
        $response = Read-Host "Install Node.js? [Y/n]"
        if ([string]::IsNullOrEmpty($response) -or $response -match '^[Yy]') {
            if (-not (Install-NodeJS)) {
                exit 1
            }
        } else {
            Write-Host "Node.js 22+ is required" -ForegroundColor $ErrorColor
            exit 1
        }
    }
    
    if (-not (Test-NodeInstalled)) {
        Write-Host "Node.js installation failed" -ForegroundColor $ErrorColor
        exit 1
    }
}

# Check for existing packages and handle accordingly
$packageName = "openclaw-cn"
if ($UseBeta) {
    $packageSpec = "openclaw-cn@beta"
} elseif ($OpenclawVersion -ne "latest") {
    $packageSpec = "openclaw-cn@$OpenclawVersion"
} else {
    $packageSpec = "openclaw-cn"
}

# Function to check if package is installed
function Test-PackageInstalled {
    param([string]$pkgName)
    
    try {
        $result = & npm list -g $pkgName --depth=0 2>$null
        if ($result -ne $null -and $result -match $pkgName) {
            return $true
        }
    } catch {}
    
    # Check for executable in npm global bin directory
    try {
        $globalBinPath = & npm bin -g 2>$null
        if ($globalBinPath) {
            $executablePath = Join-Path $globalBinPath $pkgName
            # Also check with .cmd extension on Windows
            $executablePathCmd = Join-Path $globalBinPath "$pkgName.cmd"
            $executablePathPs1 = Join-Path $globalBinPath "$pkgName.ps1"
            return (Test-Path $executablePath) -or (Test-Path $executablePathCmd) -or (Test-Path $executablePathPs1)
        }
    } catch {}
    
    return $false
}

# Check for conflicting packages (legacy package names)
$conflictingPackages = @()
foreach ($pkg in @("clawdbot-cn", "clawbot-cn")) {
    if (Test-PackageInstalled -pkgName $pkg) {
        $conflictingPackages += $pkg
    }
}

Write-Host ""

# Handle conflicting packages
if ($conflictingPackages.Count -gt 0) {
    Write-Host "[!] Found legacy package(s): $($conflictingPackages -join ', ')" -ForegroundColor $WarnColor
    
    if ($NoPrompt) {
        # In non-interactive mode, automatically uninstall conflicting packages
        Write-Host "[*] Automatically uninstalling legacy packages..." -ForegroundColor $InfoColor
        foreach ($pkg in $conflictingPackages) {
            # First run the application-level uninstall command using the old package name
            $uninstallCmd = "npx -y $pkg uninstall --all --yes --non-interactive"
            if ($DryRun) {
                Write-Host "  [dry-run] $uninstallCmd" -ForegroundColor $MutedColor
            } else {
                Write-Host "  Running application-level uninstall for $pkg..." -ForegroundColor $MutedColor
                cmd /c $uninstallCmd
                # Even if the application-level uninstall fails, we'll proceed with npm uninstall
            }
            
            # Then remove the package with npm
            $npmUninstallCmd = "npm uninstall -g `"$pkg`""
            if ($DryRun) {
                Write-Host "  [dry-run] $npmUninstallCmd" -ForegroundColor $MutedColor
            } else {
                cmd /c $npmUninstallCmd
                if ($LASTEXITCODE -ne 0) {
                    Write-Host "Warning: Failed to uninstall $pkg with npm" -ForegroundColor $WarnColor
                }
            }
        }
    } else {
        # In interactive mode, ask user if they want to uninstall
        Write-Host "This is the renamed version of Clawdbot (now OpenClaw)." -ForegroundColor $InfoColor
        $response = Read-Host "Would you like to uninstall the legacy package(s) first? [Y/n]"
        if ([string]::IsNullOrEmpty($response) -or $response -match '^[Yy]') {
            foreach ($pkg in $conflictingPackages) {
                # First run the application-level uninstall command using the old package name
                $uninstallCmd = "npx -y $pkg uninstall --all --yes --non-interactive"
                if ($DryRun) {
                    Write-Host "  [dry-run] $uninstallCmd" -ForegroundColor $MutedColor
                } else {
                    Write-Host "  Running application-level uninstall for $pkg..." -ForegroundColor $MutedColor
                    cmd /c $uninstallCmd
                    # Even if the application-level uninstall fails, we'll proceed with npm uninstall
                }
                        
                # Then remove the package with npm
                $npmUninstallCmd = "npm uninstall -g `"$pkg`""
                if ($DryRun) {
                    Write-Host "  [dry-run] $npmUninstallCmd" -ForegroundColor $MutedColor
                } else {
                    cmd /c $npmUninstallCmd
                    if ($LASTEXITCODE -ne 0) {
                        Write-Host "Warning: Failed to uninstall $pkg with npm" -ForegroundColor $WarnColor
                    }
                }
            }
        } else {
            Write-Host "Skipping legacy package uninstallation." -ForegroundColor $MutedColor
            Write-Host "Note: You may encounter conflicts during installation." -ForegroundColor $WarnColor
        }
    }
}

# Check again if conflicting packages still exist before installation
$remainingConflictingPackages = @()
foreach ($pkg in @("clawdbot-cn", "clawbot-cn")) {
    if (Test-PackageInstalled -pkgName $pkg) {
        $remainingConflictingPackages += $pkg
    }
}

if ($remainingConflictingPackages.Count -gt 0) {
    Write-Host "[!] Warning: Legacy packages still present: $($remainingConflictingPackages -join ', ')" -ForegroundColor $WarnColor
    if ($NoPrompt) {
        Write-Host "[*] Force removing remaining legacy packages..." -ForegroundColor $InfoColor
        foreach ($pkg in $remainingConflictingPackages) {
            $forceUninstallCmd = "npm uninstall -g --force `"$pkg`""
            if ($DryRun) {
                Write-Host "  [dry-run] $forceUninstallCmd" -ForegroundColor $MutedColor
            } else {
                cmd /c $forceUninstallCmd
                if ($LASTEXITCODE -ne 0) {
                    Write-Host "Warning: Force removal of $pkg failed" -ForegroundColor $WarnColor
                }
            }
        }
    } else {
        $response = Read-Host "Some legacy packages remain. Force remove them? [Y/n]"
        if ([string]::IsNullOrEmpty($response) -or $response -match '^[Yy]') {
            foreach ($pkg in $remainingConflictingPackages) {
                $forceUninstallCmd = "npm uninstall -g --force `"$pkg`""
                if ($DryRun) {
                    Write-Host "  [dry-run] $forceUninstallCmd" -ForegroundColor $MutedColor
                } else {
                    cmd /c $forceUninstallCmd
                    if ($LASTEXITCODE -ne 0) {
                        Write-Host "Warning: Force removal of $pkg failed" -ForegroundColor $WarnColor
                    }
                }
            }
        }
    }
}

# Now proceed with installation
Write-Host "[*] Installing $packageSpec..." -ForegroundColor $InfoColor
Write-Host "[*] npm registry: $NpmRegistry" -ForegroundColor $MutedColor

$npmCmd = "npm install -g `"$packageSpec`" --no-fund --no-audit --registry `"$NpmRegistry`""

if ($DryRun) {
    Write-Host "  [dry-run] $npmCmd" -ForegroundColor $MutedColor
} else {
    # Use cmd /c to execute npm reliably
    cmd /c $npmCmd
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "ERROR: npm command failed (exit code: $LASTEXITCODE)" -ForegroundColor $ErrorColor
        Write-Host "Try running manually: $npmCmd" -ForegroundColor $InfoColor
        
        # As last resort, try force install
        Write-Host "[*] Trying force install..." -ForegroundColor $InfoColor
        $forceInstallCmd = "npm install -g `"$packageSpec`" --no-fund --no-audit --registry `"$NpmRegistry`" --force"
        cmd /c $forceInstallCmd
        
        if ($LASTEXITCODE -ne 0) {
            Read-Host "Press Enter to exit"
            exit 1
        }
    }
    
    Write-Host "[OK] OpenClaw installed successfully" -ForegroundColor $SuccessColor
    
    # Refresh PATH so openclaw-cn is available
    Refresh-Path
}

# Show version
Write-Host ""
$version = $null
try {
    $version = & openclaw-cn --version 2>&1
} catch {
    # Ignore
}
if ($version -and $version -notmatch 'not recognized') {
    Write-Host "[OK] Version: $version" -ForegroundColor $SuccessColor
} else {
    Write-Host "[!] Could not verify installation - you may need to restart your terminal" -ForegroundColor $WarnColor
}

# Run onboarding
if (-not $NoOnboard -and -not $DryRun) {
    # Check if openclaw-cn is available
    $openclawAvailable = $false
    try {
        $testCmd = & openclaw-cn --version 2>&1
        if ($testCmd -and $testCmd -notmatch 'not recognized') {
            $openclawAvailable = $true
        }
    } catch {
        # Ignore
    }
    
    if ($openclawAvailable) {
        Write-Host ""
        Write-Host "[*] Starting onboarding..." -ForegroundColor $InfoColor
        Write-Host ""
        
        # Check if we're in an interactive session
        $isInteractive = $true
        
        # Try to detect if stdin is available for interaction
        try {
            # Check if we're in a non-interactive environment
            if ($Host.Name -eq "ServerRemoteHost") {
                $isInteractive = $false
            } elseif ($Host.UI.RawUI -eq $null) {
                $isInteractive = $false
            }
        } catch {
            # If there's an error accessing UI properties, assume non-interactive
            $isInteractive = $false
        }
        
        if ($isInteractive) {
            try {
                & openclaw-cn onboard
            } catch {
                Write-Host "[!] Onboarding failed: $($_.Exception.Message)" -ForegroundColor $WarnColor
                Write-Host "You can run 'openclaw-cn onboard' later to complete setup." -ForegroundColor $InfoColor
            }
        } else {
            # In non-interactive environments, just inform the user
            Write-Host "This script is running in a non-interactive environment." -ForegroundColor $WarnColor
            Write-Host "Please run 'openclaw-cn onboard' in a terminal after installation completes." -ForegroundColor $InfoColor
            Write-Host ""
            Write-Host "Press any key to continue..." -ForegroundColor $MutedColor
            try {
                $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
            } catch {
                # If we can't read keys, just continue
                Start-Sleep -Seconds 3
            }
        }
    } else {
        Write-Host ""
        Write-Host "[!] openclaw-cn not found in PATH" -ForegroundColor $WarnColor
        Write-Host "Please restart your terminal and run: openclaw-cn onboard" -ForegroundColor $InfoColor
    }
} else {
    Write-Host ""
    Write-Host "Tip: Run 'openclaw-cn onboard' to start setup" -ForegroundColor $InfoColor
}

Write-Host ""
Write-Host "Installation complete!" -ForegroundColor $SuccessColor
Write-Host ""

# Keep window open if running interactively
if ($Host.UI.RawUI.WindowTitle) {
    Write-Host "Press any key to exit..." -ForegroundColor $MutedColor
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}



👋 Hi，想聊点什么～
输入您的问题... (Enter 发送，Shift+Enter 换行)
内容由AI生成，仅供参考
