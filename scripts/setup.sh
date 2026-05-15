#!/usr/bin/env bash
set -euo pipefail

#
# TSMusicBot Setup Script (Linux/macOS)
# - Auto-detect China network, switch to npmmirror
# - Download native binaries from CDN (避开 GitHub)
# - One-click setup, same as setup.bat for Windows
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="$PROJECT_DIR/setup.log"

echo "============================================"
echo "  TSMusicBot - First-Time Setup (Linux)"
echo "============================================"
echo ""
echo "Log file: $LOG_FILE"
echo ""

# ---- Detect China network ----
USE_MIRROR=0
MIRROR_REGISTRY="https://registry.npmjs.org"
CDN_MIRROR=""

echo "Testing connection to npm registry..."
if ping -c 1 -W 4 registry.npmjs.org &>/dev/null; then
    echo "[OK] npm registry reachable."
else
    echo "[WARN] Cannot reach npm registry, using China mirror."
    USE_MIRROR=1
fi

if [ "$USE_MIRROR" = "1" ]; then
    echo "[INFO] Using China mirror (npmmirror.com)"
    MIRROR_REGISTRY="https://registry.npmmirror.com"
    CDN_MIRROR="https://cdn.npmmirror.com/binaries"
    export npm_config_registry="$MIRROR_REGISTRY"
fi
echo ""

# ---- Check build tools (needed for native module fallback) ----
if ! command -v gcc &>/dev/null && ! command -v clang &>/dev/null; then
    echo "[INFO] No C compiler found. If CDN binaries are unavailable,"
    echo "       native modules may fail. Install build tools:"
    echo "       sudo apt install build-essential  (Ubuntu/Debian)"
    echo "       sudo yum groupinstall 'Development Tools'  (CentOS/RHEL)"
    echo ""
fi

# ---- Step 1: Install dependencies (skip GitHub binaries) ----
echo "---- 1/5: Installing Node.js dependencies ----"
echo ""

cd "$PROJECT_DIR"
npm install --registry="$MIRROR_REGISTRY" --ignore-scripts 2>&1 | tee -a "$LOG_FILE"
echo "[OK] Dependencies installed."
echo ""

# ---- Step 2: Download native binaries from CDN ----
echo "---- 2/5: Downloading native binaries ----"
echo ""

if node scripts/download-binaries.mjs $CDN_MIRROR 2>&1 | tee -a "$LOG_FILE"; then
    echo "[OK] Native binaries installed."
else
    echo "[WARN] Some native binaries had issues (will try source build as fallback)."
fi
echo ""

# ---- Step 3: Install web panel dependencies ----
echo "---- 3/5: Installing web panel dependencies ----"
echo ""

if [ -f "web/package.json" ]; then
    cd "$PROJECT_DIR/web"
    npm install --registry="$MIRROR_REGISTRY" 2>&1 | tee -a "$LOG_FILE"
    cd "$PROJECT_DIR"
    echo "[OK] Web panel dependencies installed."
else
    echo "[SKIP] web/package.json not found."
fi
echo ""

# ---- Step 4: Build project ----
echo "---- 4/5: Building project ----"
echo ""

npm run build 2>&1 | tee -a "$LOG_FILE"
echo "[OK] Build succeeded."
echo ""

# ---- Step 5: Verify ----
echo "---- 5/5: Verifying build ----"
echo ""

BUILD_OK=1
if [ ! -d "dist" ]; then
    echo "[ERROR] dist/ directory missing."
    BUILD_OK=0
fi
if [ -d "web" ] && [ ! -d "web/dist" ]; then
    echo "[ERROR] web/dist/ directory missing."
    BUILD_OK=0
fi

if [ "$BUILD_OK" = "0" ]; then
    echo "Build completed but expected output is missing."
    exit 1
fi
echo "[OK] Build outputs verified."
echo ""

if [ ! -f "config.json" ]; then
    echo "[INFO] config.json will be auto-generated on first launch."
fi
echo ""

echo "============================================"
echo "  Setup Complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Run:  npm start"
echo "  2. Open: http://localhost:3000"
echo ""
echo "Setup log: $LOG_FILE"
echo ""

