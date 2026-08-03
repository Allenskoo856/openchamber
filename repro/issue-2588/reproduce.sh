#!/usr/bin/env bash
# Reproduction for openchamber/openchamber#2588
#
# "[Bug] argv[0] is replaced with the OpenChamber AppImage path for commands
#  executed in the embedded opencode session"
#
# Root cause chain (confirmed by reproducing the exact reported output):
#   1. The AppImage runtime exports `ARGV0` = the AppImage path into the
#      environment before launching Electron (AppImage type-2 runtime behavior).
#   2. OpenChamber spawns the managed `opencode serve` process with
#      `env: { ...process.env, ... }` (packages/web/server/lib/opencode/lifecycle.js),
#      so `ARGV0` is inherited by opencode untouched (OpenChamber never
#      strips/sanitizes ARGV0 anywhere in the codebase).
#   3. opencode's bash tool spawns the user's login shell (`$SHELL` = zsh here)
#      as `<shell> -c <command>`, passing that environment through.
#   4. zsh has a special `ARGV0` parameter: when `ARGV0` is exported, zsh uses
#      its value as argv[0] for every external command it spawns.
#
# Result: the command's binary is correct (`/proc/self/exe`), but argv[0] is the
# OpenChamber AppImage path — which breaks Python venv detection and anything
# else that reads argv[0]/$0.
#
# Same bug class reported against another Electron AppImage app:
#   pingdotgg/t3code#2509 ("AppImage ARGV0 leak corrupts zsh integrated terminal")
#
# Usage: bash reproduce.sh
set -u

APPIMAGE_PATH="/path/to/OpenChamber/OpenChamber-1.17.2-linux-x86_64.AppImage"
PROBE='import os, sys; print("orig_argv =", sys.orig_argv); print("executable=", sys.executable); print("exe       =", os.readlink("/proc/self/exe"))'

if ! command -v zsh >/dev/null 2>&1; then
  echo "zsh is required to reproduce this bug (the reporter uses zsh as \$SHELL)." >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required." >&2
  exit 1
fi

# $1 = full command string for zsh to run under the leaked ARGV0 env
run_via_zsh() {
  ARGV0="$APPIMAGE_PATH" zsh -c "$1"
}

echo "===== 1) CONTROL: regular terminal (no ARGV0 leaked) — expected behavior ====="
python3 -c "$PROBE"
echo

echo "===== 2) BUG: environment as inherited from the OpenChamber AppImage ====="
echo "     (AppImage runtime exports ARGV0; OpenChamber passes process.env to"
echo "      the managed opencode; opencode's bash tool spawns zsh -c '<command>')"
echo
run_via_zsh "python3 -c ${PROBE@Q}"
echo

echo "===== 3) FIX confirmation: unsetting ARGV0 restores correct argv[0] ====="
echo "     (same workaround as pingdotgg/t3code#2509)"
echo
run_via_zsh "unset ARGV0; python3 -c ${PROBE@Q}"
echo

echo "===== 4) FIX confirmation: bash does not honor exported ARGV0 ====="
echo "     (why wrapping commands in 'bash -c' is the reporter's workaround)"
echo
BASH_CMD="python3 -c ${PROBE@Q}"
run_via_zsh "bash -c ${BASH_CMD@Q}"
