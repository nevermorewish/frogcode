#!/bin/bash
# Linux 打包脚本 (在 WSL 或原生 Linux 下运行)
# 用法: bash build-linux.sh
#
# 依赖: rustup (~/.cargo/bin), node/npm, 以及 Tauri 系统依赖:
#   sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
#                    libssl-dev pkg-config build-essential curl wget

set -e

export PATH="$HOME/.cargo/bin:$PATH"
# 规避 rustc 1.94 在渲染 dead_code 警告时的 ICE
export RUSTFLAGS="-A dead_code"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 检测是否在 Windows 挂载路径 (/mnt/...)。WSL 跨文件系统构建极慢且易出错，
# 因此同步到 Linux 原生目录后再构建。
if [[ "$SCRIPT_DIR" == /mnt/* ]]; then
    BUILD_DIR="$HOME/frogcode-build"
    echo "=== Detected WSL mount path. Syncing project to $BUILD_DIR ==="
    mkdir -p "$BUILD_DIR"
    rsync -a --delete \
        --exclude='node_modules' \
        --exclude='target' \
        --exclude='.git' \
        --exclude='dist' \
        --exclude='dist-linux' \
        "$SCRIPT_DIR/" "$BUILD_DIR/"
    OUTPUT_BACK_TO="$SCRIPT_DIR/dist-linux"
else
    BUILD_DIR="$SCRIPT_DIR"
    OUTPUT_BACK_TO=""
fi

cd "$BUILD_DIR"

echo "=== Rust toolchain ==="
rustc --version
cargo --version

echo "=== Installing npm dependencies ==="
npm install

echo "=== Building frontend (tsc + vite) ==="
npm run build

echo "=== Building Tauri bundle (deb / rpm / appimage) ==="
npx tauri build

BUNDLE_DIR="$BUILD_DIR/src-tauri/target/release/bundle"
echo ""
echo "=== Build artifacts ==="
find "$BUNDLE_DIR" -type f \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) 2>/dev/null

# 如果是在 WSL 挂载路径触发的构建，把产物复制回 Windows 侧
if [[ -n "$OUTPUT_BACK_TO" ]]; then
    mkdir -p "$OUTPUT_BACK_TO"
    find "$BUNDLE_DIR" -type f \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) \
        -exec cp {} "$OUTPUT_BACK_TO/" \;
    cp "$BUILD_DIR/src-tauri/target/release/any-code" "$OUTPUT_BACK_TO/" 2>/dev/null || true
    echo ""
    echo "=== Copied to $OUTPUT_BACK_TO ==="
    ls -lh "$OUTPUT_BACK_TO"
fi

echo ""
echo "=== Done ==="
