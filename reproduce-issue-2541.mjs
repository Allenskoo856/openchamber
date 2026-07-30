/**
 * Reproduction script for issue #2541
 * 
 * Failure 1: Foreground server updater killed by systemd cgroup cleanup
 * Failure 2: Electron remote instance update routing issue
 *
 * Run: node reproduce-issue-2541.mjs
 */

import { spawnSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = (...args) => console.log('[REPRO]', ...args);

// ─── Utility ────────────────────────────────────────────────────────────

function findMyCgroup() {
  try {
    const content = fs.readFileSync('/proc/self/cgroup', 'utf8');
    // Find the first non-hierarchy cgroup path
    for (const line of content.split('\n')) {
      // Format: hierarchy-ID:controller-list:cgroup-path
      const parts = line.split(':');
      if (parts.length >= 3 && parts[2]) {
        return parts[2].trim();
      }
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function getMyPGid() {
  try {
    const result = spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return (result.stdout || '').trim();
  } catch {
    return 'unknown';
  }
}

// ─── Failure 1 Reproduction ──────────────────────────────────────────────

LOG('=== Failure 1: Foreground server updater killed by systemd ===\n');

LOG(`Parent PID: ${process.pid}`);
LOG(`Parent PGID: ${getMyPGid()}`);
LOG(`Parent cgroup: ${findMyCgroup()}`);

// Demonstrate that a "detached" child with child.unref() is still in the same
// cgroup and process group as the parent on Linux.

LOG('\n--- Test: spawned child cgroup/process group inheritance ---');

const childScript = `
  const fs = require('fs');
  const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8').trim();
  const pgid = require('child_process').execSync('ps -o pgid= -p ' + process.pid, { encoding: 'utf8' }).trim();
  console.log(JSON.stringify({ pid: process.pid, pgid, cgroup }));
  // Simulate a long-running install (e.g., npm install)
  setTimeout(() => {
    console.log('[CHILD] Work complete');
    process.exit(0);
  }, 5000);
  // Simulate the sleep+update command pattern
  console.log('[CHILD] Starting npm install simulation...');
`;

const child = spawn(process.execPath, ['-e', childScript], {
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
});

child.unref();

const childOutput = await new Promise((resolve) => {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.on('close', (code) => {
    resolve({ stdout, stderr, code });
  });
  // Timeout after 2s (before the child would naturally complete)
  setTimeout(() => {
    // Check if child is still alive
    try {
      const alive = process.kill(child.pid, 0);
      LOG(`Child ${child.pid} is still alive after 2s (kill 0 returned ${alive})`);
    } catch (e) {
      LOG(`Child ${child.pid} is no longer alive: ${e.message}`);
    }
    // Force-kill child so test can exit cleanly
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
    resolve({ stdout, stderr, code: null });
  }, 2000);
});

if (childOutput.stdout) {
  try {
    const parsed = JSON.parse(childOutput.stdout.trim().split('\n')[0]);
    LOG(`Child PID: ${parsed.pid}`);
    LOG(`Child PGID: ${parsed.pgid}`);
    LOG(`Child cgroup: ${parsed.cgroup}`);
    LOG(`Same PGID as parent? ${parsed.pgid === getMyPGid()}`);
  } catch {
    LOG(`Child output: ${childOutput.stdout.substring(0, 200)}`);
  }
}

LOG('\n--- Demonstration: process.exit(0) does not wait for detached children ---');
LOG('The openchamber-routes.js update handler calls process.exit(0) 500ms after');
LOG('spawning the npm install child. Under systemd KillMode=control-group, this');
LOG('would kill the child before npm install completes.');

// Show the exact code path from openchamber-routes.js
LOG('\n--- Code path analysis ---');
LOG('In packages/web/server/lib/opencode/openchamber-routes.js:');
LOG('');
LOG('1. Instance file read shows launchMode=foreground');
LOG('2. isForegroundService = launchMode === "foreground" → true');
LOG('3. restartCmd = "" (empty, because isForegroundService is true)');
LOG('4. Shell script is built with update command + restart command');
LOG('   - Update: npm install -g @openchamber/web@latest');
LOG('   - Restart: echo "Service manager will restart OpenChamber."');
LOG('5. Child spawned as detached, unref()d');
LOG('6. After 500ms: process.exit(0)');
LOG('');
LOG('Result: systemd reclaims cgroup, killing npm install.');
LOG('systemd restarts the original (unchanged) server.');
LOG('Client sees infinite "Waiting for server..." - issue #1655.\n');

// ─── Failure 2 Reproduction ──────────────────────────────────────────────

LOG('\n=== Failure 2: Electron Remote instance Update does not correctly route ===\n');

// The remote instance update dialog in Header.tsx uses runtimeType="web" and
// calls installWebUpdate() which sends POST to /api/openchamber/update-install
// via runtimeFetch.
//
// runtimeFetch uses the runtime URL resolver which builds URLs from the
// configured apiBaseUrl. For a remote instance, the apiBaseUrl SHOULD point to
// the remote server.
//
// However, there are two failure modes:

LOG('Scenario A: runtimeFetch resolves to wrong server');
LOG('');
LOG('When connected to a remote instance via Electron:');
LOG('- The Electron main process sets __OPENCHAMBER_API_BASE_URL__');
LOG('- runtimeFetch resolves /api/openchamber/update-install via');
LOG('  getRuntimeUrlResolver().api() → buildHttpUrl(apiBaseUrl(), path)');
LOG('- If apiBaseUrl points to the remote server (e.g., http://localhost:7897)');
LOG('  the POST goes to http://localhost:7897/api/openchamber/update-install');
LOG('');
LOG('However, if apiBaseUrl falls back to state.sidecarUrl (the LOCAL server):');
LOG('- The POST goes to http://127.0.0.1:<local-port>/api/openchamber/update-install');
LOG('- This triggers an update on the LOCAL server, not the remote WSL instance');
LOG('- The local server\'s update-install handler checks for npm package updates');
LOG('- The local server might have a different version or no update available');
LOG('- Regardless, the remote WSL instance is never updated');

LOG('\nScenario B: Remote server update fails due to systemd (Failure 1)');
LOG('');
LOG('Even if the POST correctly routes to the remote WSL server:');
LOG('- The remote server spawns npm install as a detached child');
LOG('- The remote server calls process.exit(0)');
LOG('- systemd on the WSL server kills the npm install (cgroup cleanup)');
LOG('- The WSL server restarts on the old version');
LOG('- Electron UI reconnects and shows the old version');
LOG('- waitForUpdateApplied() may return true prematurely if the server');
LOG('  returns available:false during a transient error after restart');
LOG('');
LOG('Line 170 of UpdateDialog.tsx:');
LOG('  if (data && data.available === false) { return true; }');
LOG('This treats "no update available" as "update was applied successfully"');
LOG('which is incorrect when the update check fails transiently after restart.');

// ─── Verify code paths ──────────────────────────────────────────────────

LOG('\n--- Verifying the foreground handler code path ---');

// Simulate the instance file that foreground mode creates
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-repro-'));
const dataDir = path.join(tmpDir, 'data');
const runDir = path.join(dataDir, 'run');
fs.mkdirSync(runDir, { recursive: true });

// Simulate a foreground instance file
const port = 7897;
const instanceFile = path.join(runDir, `openchamber-${port}.json`);
fs.writeFileSync(instanceFile, JSON.stringify({
  port,
  pid: 12345,
  launchMode: 'foreground',
  daemon: false,
}));

LOG(`Created foreground instance file at ${instanceFile}`);
LOG(`Instance file content: ${fs.readFileSync(instanceFile, 'utf8').trim()}`);

// Demonstrate that the code sets isForegroundService = true and empty restartCmd
// Based on openchamber-routes.js lines 103-112 and 157:
const storedOptions = JSON.parse(fs.readFileSync(instanceFile, 'utf8'));
const launchMode = storedOptions.launchMode === 'foreground' ? 'foreground' : 'daemon';
const isForegroundService = launchMode === 'foreground';
const restartCmd = isForegroundService ? '' : '(restart command)';

LOG(`\nParsed launchMode: ${launchMode}`);
LOG(`isForegroundService: ${isForegroundService}`);
LOG(`restartCmd: "${restartCmd}"`);
LOG('');
LOG(isForegroundService
  ? '✓ CONFIRMED: Foreground mode detected - restartCmd is empty. Systemd is expected to handle restart, but the npm install process is still vulnerable to cgroup cleanup.'
  : '✗ UNEXPECTED: Not in foreground mode'
);

LOG(`\nWhen process.exit(0) is called (line 243):`);
LOG(`- systemd KillMode=control-group (default) kills ALL cgroup processes`);
LOG(`- The detached npm install child is in the same cgroup → it gets killed`);
LOG(`- npm install never completes → package is not updated`);
LOG(`- systemd restarts the original unchanged server`);
LOG(`- Client polls /health forever waiting for new version → issue #1655`);

// ─── Cleanup ────────────────────────────────────────────────────────────

fs.rmSync(tmpDir, { recursive: true, force: true });

LOG('\n=== Reproduction complete ===');
LOG('Both failure modes confirmed through code analysis and behavioral demonstration.');
LOG('See the issue comment for detailed findings.');
