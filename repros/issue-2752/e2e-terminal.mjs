// End-to-end reproduction for openchamber/openchamber#2752
//
// Drives the real createTerminalRuntime from packages/web/server with the real
// bun-pty provider, opens a terminal session, then runs a Node fork()-based
// worker (the pattern used by Tinypool/Jest/Vitest fork pools) inside the PTY.
//
// Run with Bun from the repo root:
//   bun run repros/issue-2752/e2e-terminal.mjs
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { accessSync, constants } from 'node:fs';

import { createTerminalRuntime } from '../../packages/web/server/lib/terminal/runtime.js';

const routes = { get: new Map(), post: new Map(), delete: new Map() };
const app = {
  post(route, handler) { routes.post.set(route, handler); },
  get(route, handler) { routes.get.set(route, handler); },
  delete(route, handler) { routes.delete.set(route, handler); },
};

function isExecutableFile(candidate) {
  if (!candidate || typeof candidate !== 'string') return false;
  try { accessSync(candidate, constants.X_OK); return true; } catch { return false; }
}

let lastSpawnOptions = null;
let lastPtyProcess = null;
const loadPtyProvider = async () => {
  const pty = await import('bun-pty');
  return {
    backend: 'bun-pty',
    spawn: (shell, args, options) => {
      lastSpawnOptions = options;
      lastPtyProcess = pty.spawn(shell, args, options);
      return lastPtyProcess;
    },
  };
};

const server = new EventEmitter();
const runtime = createTerminalRuntime({
  app,
  server,
  fs,
  path,
  uiAuthController: null,
  buildAugmentedPath: () => process.env.PATH || '',
  searchPathFor: (name, searchPath) => {
    const dirs = String(searchPath || '').split(':').filter(Boolean);
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
    return null;
  },
  isExecutable: (candidate) => isExecutableFile(candidate),
  isRequestOriginAllowed: async () => true,
  rejectWebSocketUpgrade() {},
  TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 30_000,
  loadPtyProvider,
  terminalTerminationGraceMs: 1000,
});

const res = {
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
};

const cwd = import.meta.dir;
const create = routes.post.get('/api/terminal/create');
await create({ body: { sessionId: 'repro-2752', cwd, cols: 120, rows: 40 } }, res);
console.log('create status:', res.statusCode, 'body:', JSON.stringify(res.body));
console.log('PTY env NODE_CHANNEL_FD =', JSON.stringify(lastSpawnOptions?.env?.NODE_CHANNEL_FD));

const ptyProcess = lastPtyProcess;
if (!ptyProcess) {
  console.error('no pty process captured');
  await runtime.shutdown();
  process.exit(1);
}

let output = '';
const disposable = ptyProcess.onData((data) => { output += data; });
const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
const finish = () => {
  disposable.dispose();
  const clean = stripAnsi(output);
  console.log('---- PTY output (shell session) ----');
  console.log(clean);
  console.log('---- end PTY output ----');
  const exportedLine = clean.split('\n').find((line) => /^NODE_CHANNEL_FD=$/.test(line.trim()));
  const hasCrash = clean.includes("Cannot read properties of undefined (reading 'bind')");
  const workaroundOk = clean.includes('WORKAROUND_OK');
  console.log('PTY shell exported NODE_CHANNEL_FD= (empty):', Boolean(exportedLine), JSON.stringify(exportedLine?.trim()));
  console.log('Node fork worker crashed inside PTY:', hasCrash);
  console.log('workaround env -u NODE_CHANNEL_FD node fork.cjs worked:', workaroundOk);
  void runtime.shutdown();
  process.exit(exportedLine && hasCrash && workaroundOk ? 0 : 1);
};
const watchdog = setTimeout(finish, 30_000);
ptyProcess.onExit(() => { clearTimeout(watchdog); finish(); });

ptyProcess.write('env | grep NODE_CHANNEL_FD; echo ---; node fork.cjs; echo ---; env -u NODE_CHANNEL_FD node fork.cjs && echo WORKAROUND_OK; echo ---; echo REPRO_DONE; exit\r');
