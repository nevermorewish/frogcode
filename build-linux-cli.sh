#!/bin/bash
# Build frogcode-cli (headless Linux binary) only.
# Usage (from WSL / native Linux):
#   bash build-linux-cli.sh                 # release build
#   bash build-linux-cli.sh --debug         # debug build (faster, bigger)
#
# Dependencies (install once, requires sudo):
#   sudo apt install -y build-essential pkg-config libssl-dev \
#                       libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
#                       librsvg2-dev libayatana-appindicator3-dev
#
# And rustup (the rsproxy.cn mirror is fast in CN):
#   curl --proto '=https' --tlsv1.2 -sSf https://rsproxy.cn/rustup-init.sh | \
#     RUSTUP_DIST_SERVER=https://rsproxy.cn RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup \
#     sh -s -- -y --default-toolchain stable --profile minimal

set -e

export PATH="$HOME/.cargo/bin:$PATH"

# Workaround: rustc 1.95.0 has a diagnostic-renderer ICE triggered by some
# unused-import warnings in this crate. Capping lints sidesteps the bad path.
export RUSTFLAGS="--cap-lints allow"

PROFILE_FLAG="--release"
PROFILE_DIR="release"
if [[ "${1:-}" == "--debug" ]]; then
    PROFILE_FLAG=""
    PROFILE_DIR="debug"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# WSL 跨文件系统构建极慢。检测到 /mnt/... 时，rsync 到 Linux 原生目录再编。
if [[ "$SCRIPT_DIR" == /mnt/* ]]; then
    BUILD_DIR="$HOME/frogcode-build"
    echo "=== WSL mount detected. Syncing to $BUILD_DIR ==="
    mkdir -p "$BUILD_DIR"
    rsync -a --delete \
        --exclude='node_modules' \
        --exclude='target' \
        --exclude='.git' \
        --exclude='dist' \
        --exclude='dist-linux' \
        "$SCRIPT_DIR/" "$BUILD_DIR/"
    COPY_BACK_TO="$SCRIPT_DIR/dist-linux"
else
    BUILD_DIR="$SCRIPT_DIR"
    COPY_BACK_TO=""
fi

# Keep a dedicated target dir so a Windows-host checkout's target/ is
# never touched by WSL builds (SQLite/rocksdb C deps would clash).
export CARGO_TARGET_DIR="$HOME/frogcode-target"

cd "$BUILD_DIR/src-tauri"

echo "=== Rust toolchain ==="
rustc --version
cargo --version

echo "=== cargo build $PROFILE_FLAG --bin frogcode-cli ==="
cargo build $PROFILE_FLAG --bin frogcode-cli

BIN="$CARGO_TARGET_DIR/$PROFILE_DIR/frogcode-cli"

echo ""
echo "=== Artifact ==="
file "$BIN"
ls -lh "$BIN"

# If triggered from a WSL mount, copy the binary back to Windows side.
if [[ -n "$COPY_BACK_TO" ]]; then
    mkdir -p "$COPY_BACK_TO"
    cp "$BIN" "$COPY_BACK_TO/"
    echo ""
    echo "=== Copied to $COPY_BACK_TO/frogcode-cli ==="
fi

echo ""
echo "=== Done ==="
