import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(electronRoot, '../..');
const electronPackage = JSON.parse(fs.readFileSync(path.join(electronRoot, 'package.json'), 'utf8'));
const rootPackage = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'));
const version = electronPackage.version;
const openCodeVersion = rootPackage.dependencies?.['@opencode-ai/sdk'];
const distDir = path.join(electronRoot, 'dist');
const mediaRoot = path.join(distDir, 'offline-media');
const mediaName = `openchamber-uos1070-x86_64-v${version}`;
const mediaDir = path.join(mediaRoot, mediaName);
const appImageName = `OpenChamber-${version}-linux-x86_64.AppImage`;
const appImagePath = path.join(distDir, appImageName);
const iconPath = path.join(electronRoot, 'resources', 'icons', 'icon.png');
const archiveName = `OpenChamber-${version}-uos1070-x86_64-offline.tar.gz`;
const archivePath = path.join(distDir, archiveName);

const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const writeExecutable = (filePath, content) => {
  fs.writeFileSync(filePath, content, 'utf8');
  fs.chmodSync(filePath, 0o755);
};

const installer = ({ imageName, imageSha }) => `#!/bin/sh
set -eu

MEDIA_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_IMAGE=${JSON.stringify(imageName)}
EXPECTED_SHA256=${JSON.stringify(imageSha)}

if [ "$(uname -m)" != "x86_64" ] && [ "$(uname -m)" != "amd64" ]; then
  echo "OpenChamber UOS 1070 media requires x86_64; found $(uname -m)." >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA256=$(sha256sum "$MEDIA_DIR/$APP_IMAGE" | awk '{print $1}')
else
  ACTUAL_SHA256=$(openssl dgst -sha256 "$MEDIA_DIR/$APP_IMAGE" | awk '{print $NF}')
fi
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  echo "AppImage checksum mismatch." >&2
  exit 1
fi

GLIBC_VERSION=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}' || true)
if [ -n "$GLIBC_VERSION" ] && [ "$(printf '%s\\n' 2.28 "$GLIBC_VERSION" | sort -V | head -n1)" != "2.28" ]; then
  echo "OpenChamber requires glibc >= 2.28; found $GLIBC_VERSION." >&2
  exit 1
fi

HOME_DIR=\${HOME:?HOME must be set}
INSTALL_ROOT=\${OPENCHAMBER_INSTALL_DIR:-"$HOME_DIR/.local/opt/openchamber"}
BIN_DIR=\${OPENCHAMBER_BIN_DIR:-"$HOME_DIR/.local/bin"}
CONFIG_HOME=\${XDG_CONFIG_HOME:-"$HOME_DIR/.config"}
DATA_HOME=\${XDG_DATA_HOME:-"$HOME_DIR/.local/share"}
CONFIG_DIR="$CONFIG_HOME/openchamber"
DESKTOP_DIR="$DATA_HOME/applications"
APP_PATH="$INSTALL_ROOT/OpenChamber.AppImage"
ICON_PATH="$INSTALL_ROOT/icon.png"
LAUNCHER_PATH="$BIN_DIR/openchamber"
DESKTOP_ENTRY="$DESKTOP_DIR/openchamber-uos1070.desktop"

mkdir -p "$INSTALL_ROOT" "$BIN_DIR" "$CONFIG_DIR" "$DESKTOP_DIR"
cp "$MEDIA_DIR/$APP_IMAGE" "$APP_PATH"
chmod 755 "$APP_PATH"
cp "$MEDIA_DIR/icon.png" "$ICON_PATH"
chmod 644 "$ICON_PATH"

if [ -f "$CONFIG_DIR/offline.env" ]; then
  # Optional operator file for internal model hosts. It must contain shell
  # assignments only; the offline mode default is always restored below.
  . "$CONFIG_DIR/offline.env"
fi

cat > "$LAUNCHER_PATH" <<'LAUNCHER'
#!/bin/sh
set -eu
HOME_DIR=\${HOME:?HOME must be set}
CONFIG_HOME=\${XDG_CONFIG_HOME:-"$HOME_DIR/.config"}
CONFIG_FILE="$CONFIG_HOME/openchamber/offline.env"
if [ -f "$CONFIG_FILE" ]; then . "$CONFIG_FILE"; fi
export OPENCHAMBER_OFFLINE_MODE=1
export OPENCHAMBER_DISABLE_EXTERNAL_NETWORK=1
export APPIMAGE_EXTRACT_AND_RUN=\${APPIMAGE_EXTRACT_AND_RUN:-1}
exec "__OPENCHAMBER_APP_PATH__" "$@"
LAUNCHER
sed "s|__OPENCHAMBER_APP_PATH__|$APP_PATH|g" "$LAUNCHER_PATH" > "$LAUNCHER_PATH.tmp"
mv "$LAUNCHER_PATH.tmp" "$LAUNCHER_PATH"
chmod 755 "$LAUNCHER_PATH"

cat > "$DESKTOP_ENTRY" <<DESKTOP
[Desktop Entry]
Name=OpenChamber (UOS 1070 Offline)
Comment=OpenChamber desktop, offline-first internal deployment
Exec=$LAUNCHER_PATH %U
Icon=$ICON_PATH
Terminal=false
Type=Application
Categories=Development;Utility;
StartupWMClass=openchamber
DESKTOP
chmod 644 "$DESKTOP_ENTRY"

echo "Installed OpenChamber $APP_IMAGE"
echo "Launcher: $LAUNCHER_PATH"
echo "Optional internal model configuration: $CONFIG_DIR/offline.env"
echo "Run: $LAUNCHER_PATH"
`;

const uninstall = `#!/bin/sh
set -eu
HOME_DIR=\${HOME:?HOME must be set}
INSTALL_ROOT=\${OPENCHAMBER_INSTALL_DIR:-"$HOME_DIR/.local/opt/openchamber"}
BIN_DIR=\${OPENCHAMBER_BIN_DIR:-"$HOME_DIR/.local/bin"}
CONFIG_HOME=\${XDG_CONFIG_HOME:-"$HOME_DIR/.config"}
DATA_HOME=\${XDG_DATA_HOME:-"$HOME_DIR/.local/share"}
rm -rf -- "$INSTALL_ROOT"
rm -f -- "$BIN_DIR/openchamber"
rm -f -- "$DATA_HOME/applications/openchamber-uos1070.desktop"
echo "Removed OpenChamber desktop files; kept $CONFIG_HOME/openchamber for operator settings."
`;

if (!fs.existsSync(appImagePath)) {
  throw new Error(`Linux x86_64 AppImage not found: ${appImagePath}`);
}
if (!openCodeVersion || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(openCodeVersion)) {
  throw new Error(`Invalid pinned OpenCode version: ${openCodeVersion || '(missing)'}`);
}

fs.rmSync(mediaRoot, { recursive: true, force: true });
fs.mkdirSync(mediaDir, { recursive: true });
fs.copyFileSync(appImagePath, path.join(mediaDir, appImageName));
if (!fs.existsSync(iconPath)) throw new Error(`Missing desktop icon: ${iconPath}`);
fs.copyFileSync(iconPath, path.join(mediaDir, 'icon.png'));
const imageSha = sha256(path.join(mediaDir, appImageName));
const iconSha = sha256(path.join(mediaDir, 'icon.png'));

const manifest = {
  schemaVersion: 1,
  product: 'OpenChamber Desktop',
  version,
  target: 'uos1070-debian10',
  architecture: 'x86_64',
  buildBaseline: 'debian:10',
  glibcBaseline: '2.28',
  appImage: appImageName,
  appImageSha256: imageSha,
  icon: 'icon.png',
  iconSha256: iconSha,
  openCodeCliVersion: openCodeVersion,
  offlineMode: true,
  externalNetworkPolicy: 'blocked-by-default; loopback/private/explicit-allowlist only',
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(mediaDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(mediaDir, 'SHA256SUMS'), `${imageSha}  ${appImageName}\n${iconSha}  icon.png\n`);
fs.writeFileSync(path.join(mediaDir, 'offline.env.example'), `# Copy to ~/.config/openchamber/offline.env when an internal model gateway is needed.\nOPENCHAMBER_OFFLINE_MODE=1\nOPENCHAMBER_DISABLE_EXTERNAL_NETWORK=1\n# Comma-separated internal hostnames/IPs only; leave empty for default policy.\nOPENCHAMBER_OFFLINE_ALLOWED_HOSTS=\n`);
writeExecutable(path.join(mediaDir, 'install.sh'), installer({ imageName: appImageName, imageSha }));
writeExecutable(path.join(mediaDir, 'uninstall.sh'), uninstall);
fs.writeFileSync(path.join(mediaDir, 'README.md'), `# OpenChamber UOS 1070 离线介质\n\n- 目标：UOS 1070 / Debian 10 / x86_64\n- OpenChamber：${version}\n- 内置 OpenCode CLI：${openCodeVersion}\n- 构建基线：Debian 10（glibc 2.28）\n- 网络策略：默认拒绝公共 HTTP(S)/WS(S)，仅允许回环、私网、链路本地和显式内网白名单。\n\n安装：\n\n\`\`\`sh\n./install.sh\n\n# 安装后启动\n$HOME/.local/bin/openchamber\n\`\`\`\n\n若要连接内网模型网关，复制 \`offline.env.example\` 到 \`~/.config/openchamber/offline.env\`，只填写内网地址，然后重新启动。\n`);

try {
  execFileSync('tar', ['-C', mediaRoot, '-czf', archivePath, mediaName], { stdio: 'inherit' });
} catch (error) {
  throw new Error(`Failed to create offline archive: ${error.message}`);
}
const archiveSha = sha256(archivePath);
fs.writeFileSync(`${archivePath}.sha256`, `${archiveSha}  ${archiveName}\n`);

console.log(`[offline-media] ready: ${archivePath}`);
console.log(`[offline-media] media directory: ${mediaDir}`);
console.log(`[offline-media] AppImage sha256: ${imageSha}`);
