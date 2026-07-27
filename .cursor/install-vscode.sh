#!/usr/bin/env bash
# Idempotent VS Code CLI install for Cursor Cloud agent VMs.
# Used by `.cursor/environment.json` so Extension Development Host testing
# is available without a one-off apt install each run.
set -euo pipefail

if command -v code >/dev/null 2>&1; then
  echo "[install-vscode] already present: $(command -v code) ($(code --version | head -n1))"
  exit 0
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "[install-vscode] ERROR: apt-get is required to install VS Code" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "[install-vscode] installing Microsoft VS Code apt repository + package"
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends ca-certificates curl gnupg

sudo install -d -m 0755 /etc/apt/keyrings
curl --retry 5 --retry-delay 2 --retry-all-errors -fsSL \
  https://packages.microsoft.com/keys/microsoft.asc \
  | gpg --dearmor \
  | sudo tee /etc/apt/keyrings/packages.microsoft.gpg >/dev/null
sudo chmod a+r /etc/apt/keyrings/packages.microsoft.gpg

arch="$(dpkg --print-architecture)"
codename="$(. /etc/os-release && echo "${VERSION_CODENAME}")"
echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/packages.microsoft.gpg] https://packages.microsoft.com/repos/code stable main" \
  | sudo tee /etc/apt/sources.list.d/vscode.list >/dev/null

# Avoid interactive "add Microsoft apt repository?" prompt from the code package.
echo 'code code/add-microsoft-repo boolean true' | sudo debconf-set-selections

sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends code

if ! command -v code >/dev/null 2>&1; then
  echo "[install-vscode] ERROR: code not on PATH after install" >&2
  exit 1
fi

echo "[install-vscode] installed: $(command -v code) ($(code --version | head -n1))"
