#!/usr/bin/env bash
# Launch the OpenChamber desktop app under xvfb with CDP debugging enabled,
# for startup frame capture (issue #2762 reproduction).
#
# Runs `electron .` from packages/electron so that Electron loads the package
# (app path = packages/electron) and app.getVersion() resolves to the real
# version from package.json (1.18.1). Requires dist-bundle/main.mjs to have
# been produced by `bun run --cwd packages/electron bundle:main`.
set -u
cd "$(dirname "$0")/../packages/electron"

export OPENCHAMBER_ELECTRON_DEV=1
export OPENCHAMBER_HMR_UI_PORT=5173
export OPENCHAMBER_HMR_API_PORT=3000
export OPENCHAMBER_DISABLE_PWA_DEV=1
export ELECTRON_ENABLE_LOGGING=1

exec xvfb-run -a -s "-screen 0 1280x900x24" \
  ./node_modules/.bin/electron --no-sandbox --remote-debugging-port=9222 --enable-logging .
