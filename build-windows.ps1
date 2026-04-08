# Windows 打包脚本 (PowerShell)
# 用法: pwsh -File build-windows.ps1
#
# 依赖: Rust (rustup), Node.js/npm, Visual Studio Build Tools (C++ 工作负载),
#       WebView2 Runtime

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# 加载 .env.local 中的环境变量 (若存在)
if (Test-Path .env.local) {
    Write-Host "=== Loading .env.local ==="
    Get-Content .env.local | ForEach-Object {
        if ($_ -match '^\s*([^#=][^=]*)=(.*)$') {
            $key = $matches[1].Trim()
            $value = $matches[2].Trim()
            [System.Environment]::SetEnvironmentVariable($key, $value, 'Process')
            Write-Host "  Loaded: $key"
        }
    }
} else {
    Write-Host "Note: .env.local not found (skipping)"
}

Write-Host ""
Write-Host "=== Rust toolchain ==="
rustc --version
cargo --version

Write-Host ""
Write-Host "=== Installing npm dependencies ==="
npm install
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

Write-Host ""
Write-Host "=== Building frontend (tsc + vite) ==="
npm run build
if ($LASTEXITCODE -ne 0) { throw "frontend build failed" }

Write-Host ""
Write-Host "=== Building Tauri bundle (msi / nsis) ==="
npx tauri build $args
if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }

$bundleDir = Join-Path $PSScriptRoot 'src-tauri\target\release\bundle'
Write-Host ""
Write-Host "=== Build artifacts ==="
if (Test-Path $bundleDir) {
    Get-ChildItem -Path $bundleDir -Recurse -File `
        -Include *.msi, *.exe `
        | Select-Object FullName, @{Name='Size(MB)'; Expression={[math]::Round($_.Length/1MB, 2)}} `
        | Format-Table -AutoSize
} else {
    Write-Warning "Bundle directory not found: $bundleDir"
}

Write-Host "=== Done ==="
