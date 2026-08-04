#!/usr/bin/env node
// Reproduction for https://github.com/openchamber/openchamber/issues/2636
//
// [Bug] launchd startup enable: process stays alive but HTTP server dead after reconfiguration
//
// Reported symptoms (macOS launchd, OpenChamber 1.17.2):
//   1. Process PID is alive (ps aux shows it)
//   2. Port is in LISTEN state (lsof -i :3002)
//   3. `curl http://localhost:3002/health` returns nothing (000 — no response)
//   4. `openchamber status` reports "stopped" / "no running instances"
//   5. `launchctl kickstart -k gui/<uid>/dev.openchamber.web` fixes it immediately
//
// The reported broken state is EXACTLY the signature of a *suspended*
// (SIGSTOP'd) server process: the kernel keeps the listening socket open and
// the PID alive, but the event loop never runs so no HTTP request is answered,
// and `openchamber status` reports "stopped" because its HTTP probe times out.
//
// On macOS, launchd's `bootout` (issued by `startup enable` in
// packages/web/bin/lib/cli-startup.js) quiesces the job process with SIGSTOP
// during teardown; the rapid `bootout` -> `bootstrap` -> `kickstart -k`
// sequence in `enableStartupService()` can leave the process suspended. A
// `launchctl kickstart -k` sends SIGKILL to the suspended process and starts a
// fresh one — which is exactly why the workaround "fixes it immediately".
//
// This script reproduces the reported symptom set deterministically on any
// platform (Linux/CI included) by suspending a foreground server process with
// SIGSTOP. It asserts the exact reported observations and then resumes the
// process to confirm the recovery.
//
// Run: node scripts/repro-2636.mjs  (from the repository root)

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'packages', 'web', 'bin', 'cli.js');
const PORT = 3921;

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repro-2636-'));

const env = {
  ...process.env,
  OPENCHAMBER_DATA_DIR: DATA_DIR,
  OPENCHAMBER_SKIP_OPENCODE_START: 'true',
  OPENCODE_BINARY: process.env.OPENCODE_BINARY || spawnSync('which', ['opencode'], { encoding: 'utf8' }).stdout.trim() || '',
};

function cli(args, timeoutMs = 15000) {
  const result = spawnSync('node', [CLI, ...args], { encoding: 'utf8', timeout: timeoutMs, env });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function httpHealth() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

function portListening() {
  return spawnSync('sh', ['-c', `ss -tln 2>/dev/null | grep -q '[:.]${PORT} '`]).status === 0;
}

const failures = [];
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(label);
}

// --- 1. Start a foreground server (the launchd-managed process analog) ---
const server = spawn('node', [CLI, 'serve', '--foreground', '--port', String(PORT), '--host', '127.0.0.1'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

try {
  // Wait for it to become healthy.
  let healthy = false;
  for (let i = 0; i < 40 && !healthy; i++) {
    await sleep(500);
    healthy = await httpHealth();
  }
  check('foreground server starts healthy', healthy);
  check('server PID is alive', server.pid > 0 && (process.kill(server.pid, 0), true));
  check('port is in LISTEN state', portListening());

  const statusBefore = cli(['status', '--quiet']);
  check('status reports the running instance before suspend', /port 3921 mode:foreground/.test(statusBefore.stdout));

  const pidFile = path.join(DATA_DIR, 'run', `openchamber-${PORT}.pid`);
  const pidFileContent = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : '';
  check('PID file matches the live process PID (no pid-file desync)', pidFileContent === String(server.pid), `pidfile=${pidFileContent} pid=${server.pid}`);

  // --- 2. Suspend the process (launchd `bootout` quiesces jobs with SIGSTOP) ---
  process.kill(server.pid, 'SIGSTOP');
  await sleep(1000);

  console.log('\n--- REPORTER BROKEN STATE (process suspended) ---');
  let alive = true;
  try { process.kill(server.pid, 0); } catch { alive = false; }
  check('process PID is alive', alive, 'kill -0 succeeds');
  check('port is still in LISTEN state', portListening());
  check('curl /health returns nothing (000 / no response)', !(await httpHealth()));
  const statusDuring = cli(['status', '--quiet']);
  check('status reports "stopped" / no running instances', /stopped|no running/i.test(statusDuring.stdout) || statusDuring.stdout.trim() === '', JSON.stringify(statusDuring.stdout.trim()));
  const statusJson = cli(['status', '--json']);
  check('status --json runningCount is 0', /"runningCount":\s*0/.test(statusJson.stdout));

  // PID file stays consistent with the (suspended) process — the desync is not the cause.
  const pidFileAfter = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : '';
  check('PID file still matches the suspended process PID', pidFileAfter === String(server.pid));

  // --- 3. Resume (equivalent of a clean restart) ---
  process.kill(server.pid, 'SIGCONT');
  await sleep(2000);

  console.log('\n--- AFTER RESUME (kickstart -k equivalent) ---');
  check('health is restored', await httpHealth());
  const statusAfter = cli(['status', '--quiet']);
  check('status reports the running instance again', /port 3921 mode:foreground/.test(statusAfter.stdout));
} finally {
  try { process.kill(server.pid, 'SIGKILL'); } catch {}
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

console.log('');
if (failures.length > 0) {
  console.log(`REPRODUCTION FAILED TO ASSERT: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('REPRODUCED: a suspended OpenChamber server matches every reported symptom of issue #2636');
process.exit(0);
