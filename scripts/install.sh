#!/usr/bin/env bash
set -euo pipefail

#
# TSMusicBot Installer (Linux, systemd)
# - Installs system packages and Node.js 22 LTS
# - Runs scripts/setup.sh to install dependencies, verify native binaries and build
# - Copies the build to /opt/tsmusicbot and registers a systemd service (auto-start on boot)
#
# Only want to build and run it yourself (no Node install, no service)?
# Use scripts/setup.sh instead — see README「Linux 安装脚本」.
#

echo "╔══════════════════════════════════════╗"
echo "║       TSMusicBot Installer           ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Resolve script location → project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="/opt/tsmusicbot"
SERVICE_NAME="tsmusicbot"
# Node LTS line to install when a supported Node is missing. Keep in sync with
# package.json "engines" and the floor check in setup.sh (#152).
NODE_LTS_MAJOR=22

# Verify we're in a valid project directory
if [ ! -f "$PROJECT_DIR/package.json" ]; then
    echo "Error: Cannot find package.json in $PROJECT_DIR"
    echo "Please run this script from the TSMusicBot project directory."
    exit 1
fi

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    echo "Unsupported OS"
    exit 1
fi

# Supported: 22.12+ or 24+ (odd majors are excluded by better-sqlite3 and vitest).
node_supported() {
    command -v node &> /dev/null &&
        node -e 'const v=process.versions.node.split(".").map(Number); process.exit((v[0]===22&&v[1]>=12)||v[0]>=24?0:1)'
}

echo "[1/5] Installing system dependencies..."
case $OS in
    ubuntu|debian)
        sudo apt-get update -qq
        sudo apt-get install -y -qq curl ca-certificates build-essential python3 ffmpeg
        ;;
    centos|rhel|fedora|rocky|almalinux)
        sudo yum install -y curl gcc gcc-c++ make python3
        ;;
    arch|manjaro)
        sudo pacman -S --noconfirm --needed curl base-devel python ffmpeg
        ;;
    *)
        echo "Unsupported OS: $OS. Please install Node.js ${NODE_LTS_MAJOR}.12+ and build tools manually."
        ;;
esac

echo "[2/5] Installing Node.js ${NODE_LTS_MAJOR} LTS..."
if node_supported; then
    echo "Node.js $(node -v) already installed"
else
    case $OS in
        ubuntu|debian)
            curl -fsSL "https://deb.nodesource.com/setup_${NODE_LTS_MAJOR}.x" | sudo -E bash -
            sudo apt-get install -y -qq nodejs
            ;;
        centos|rhel|fedora|rocky|almalinux)
            curl -fsSL "https://rpm.nodesource.com/setup_${NODE_LTS_MAJOR}.x" | sudo bash -
            sudo yum install -y nodejs
            ;;
        arch|manjaro)
            sudo pacman -S --noconfirm --needed nodejs npm
            ;;
    esac
    if ! node_supported; then
        echo "Error: Node.js 22.12+ (or 24+) is required, found: $(node -v 2>/dev/null || echo none)."
        echo "Install it from https://nodejs.org/ (or https://nodejs.cn/) and re-run this script."
        exit 1
    fi
    echo "Node.js $(node -v) installed"
fi

echo "[3/5] Installing dependencies and building (scripts/setup.sh)..."
bash "$SCRIPT_DIR/setup.sh"

echo "[4/5] Copying to $INSTALL_DIR..."
# Stop a running copy before replacing its files (re-install / upgrade).
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    sudo systemctl stop "$SERVICE_NAME"
fi
sudo mkdir -p "$INSTALL_DIR"
# Replace build output wholesale so files removed upstream don't linger.
# data/ (config, database, cookies) is never touched.
sudo rm -rf "$INSTALL_DIR/dist" "$INSTALL_DIR/node_modules" "$INSTALL_DIR/web/dist"
sudo cp -r "$PROJECT_DIR/dist" "$INSTALL_DIR/"
sudo cp -r "$PROJECT_DIR/node_modules" "$INSTALL_DIR/"
sudo cp "$PROJECT_DIR/package.json" "$INSTALL_DIR/"
# Copy web frontend if built
if [ -d "$PROJECT_DIR/web/dist" ]; then
    sudo mkdir -p "$INSTALL_DIR/web"
    sudo cp -r "$PROJECT_DIR/web/dist" "$INSTALL_DIR/web/"
fi
# yt-dlp is looked up in bin/ next to dist/ before falling back to PATH
if [ -d "$PROJECT_DIR/bin" ]; then
    sudo cp -r "$PROJECT_DIR/bin" "$INSTALL_DIR/"
fi
# Copy scripts for future use
sudo mkdir -p "$INSTALL_DIR/scripts"
sudo cp -r "$PROJECT_DIR/scripts/"* "$INSTALL_DIR/scripts/" 2>/dev/null || true
# Create data directory
sudo mkdir -p "$INSTALL_DIR/data"

echo "[5/5] Creating systemd service..."
NODE_BIN="$(command -v node)"
sudo tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<EOL
[Unit]
Description=TSMusicBot - TeamSpeak Music Bot
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/dist/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOL

sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}
sudo systemctl restart ${SERVICE_NAME}

echo ""
echo "╔══════════════════════════════════════╗"
echo "║    TSMusicBot installed and running! ║"
echo "║                                      ║"
echo "║    WebUI: http://localhost:3000      ║"
echo "║                                      ║"
echo "║    Commands:                         ║"
echo "║    systemctl status tsmusicbot       ║"
echo "║    systemctl restart tsmusicbot      ║"
echo "║    systemctl stop tsmusicbot         ║"
echo "║    journalctl -u tsmusicbot -f       ║"
echo "╚══════════════════════════════════════╝"
