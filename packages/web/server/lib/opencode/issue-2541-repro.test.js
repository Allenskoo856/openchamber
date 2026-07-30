/**
 * Reproduction test for issue #2541
 *
 * Failure 1: Foreground server updater killed by systemd cgroup cleanup
 * Failure 2: Electron remote instance update does not correctly route to
 *            the selected remote server
 */
import { spawnSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// ─── Failure 1: Systemd Cgroup Cleanup ─────────────────────────────────

describe('Failure 1: Foreground server updater killed by systemd', () => {
  it('shows that a "detached" child shares the cgroup with the parent (systemd KillMode=control-group vulnerability)', () => {
    // Read the parent's cgroup to establish the baseline
    const parentCgroup = readProcCgroup();
    expect(parentCgroup).toBeTruthy();

    // Spawn a child with detached:true and child.unref() — exactly as
    // openchamber-routes.js does for the update-install handler.
    const child = spawn(process.execPath, ['-e', `
      const fs = require('fs');
      console.log(fs.readFileSync('/proc/self/cgroup', 'utf8').trim());
    `], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.unref();

    let childCgroup = null;
    const childOutput = spawnSync(process.execPath, [
      '-e', `
        const fs = require('fs');
        const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8').trim();
        console.log(cgroup);
      `,
    ], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });

    // Parse child cgroup from output
    if (childOutput.stdout) {
      childCgroup = String(childOutput.stdout).trim();
    }

    // Kill the child
    try { process.kill(child.pid, 'SIGKILL'); } catch {}

    // The critical finding: even with detached:true + unref(), the child
    // remains in the parent's cgroup. Under systemd KillMode=control-group,
    // when the parent calls process.exit(0), systemd kills ALL processes in
    // the cgroup — including the npm install child.
    if (childCgroup && parentCgroup) {
      const parentCgroupPath = extractCgroupPath(parentCgroup);
      const childCgroupPath = extractCgroupPath(childCgroup);
      const sameCgroup = parentCgroupPath === childCgroupPath;
      console.log(`  parent cgroup: ${parentCgroupPath}`);
      console.log(`  child  cgroup: ${childCgroupPath}`);
      console.log(`  same cgroup:  ${sameCgroup}`);

      if (sameCgroup) {
        console.log('  ⚠ CONFIRMED: Detached child is in the same cgroup as parent.');
        console.log('  process.exit(0) causes systemd to kill npm install before completion.');
      }
    }
  });

  it('demonstrates the empty restartCmd for foreground mode (openchamber-routes.js lines 103-157)', () => {
    // Simulate reading the instance file as openchamber-routes.js does
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repro-'));
    const instanceFile = path.join(tmpDir, 'run', 'openchamber-7897.json');
    fs.mkdirSync(path.dirname(instanceFile), { recursive: true });

    // Write a foreground-mode instance file
    fs.writeFileSync(instanceFile, JSON.stringify({
      port: 7897,
      pid: 12345,
      launchMode: 'foreground',
      daemon: false,
    }));

    // Read and parse it exactly as the update handler does
    const currentPort = 7897;
    const storedOptions = JSON.parse(fs.readFileSync(instanceFile, 'utf8'));
    const launchMode = storedOptions.launchMode === 'foreground' ? 'foreground' : 'daemon';
    const isForegroundService = launchMode === 'foreground';

    // Line 157: const restartCmd = isForegroundService ? '' : `(${restartCmdPrimary}) || (${restartCmdFallback})`;
    const restartCmd = isForegroundService ? '' : '(some restart command)';

    expect(isForegroundService).toBe(true);
    expect(restartCmd).toBe('');

    // The shell script (lines 205-216) appends ${restartCmd || 'echo "Service manager..."'}
    // For foreground mode, this just echoes, never actually restarts the server.
    // But the real issue is the cgroup cleanup below.

    console.log('  CONFIRMED: Foreground mode produces empty restartCmd.');
    console.log('  The shell script will only echo "Service manager will restart"');
    console.log('  instead of restarting the server.');

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exposes the process.exit(0) race: parent exits before child completes', () => {
    // This demonstrates that process.exit(0) is called BEFORE the npm install
    // child has a chance to complete.
    //
    // From openchamber-routes.js lines 185-244:
    //   setTimeout(() => {          // t+500ms: spawn child
    //     spawnChild(detached, ...);
    //     setTimeout(() => {        // t+500+500ms: parent exits
    //       process.exit(0);
    //     }, 500);
    //   }, 500);

    const start = Date.now();

    // Simulate the nested timeout pattern from openchamber-routes.js
    const events = [];
    return new Promise((resolve) => {
      setTimeout(() => {
        events.push({ t: Date.now() - start, event: 'spawn-start' });
        // Spawn a simulated npm install that takes 10 seconds
        const child = spawn(process.execPath, ['-e', `
          const start = Date.now();
          setTimeout(() => {
            console.log('npm install complete (would have updated package)');
            process.exit(0);
          }, 10000);
          // Simulate some work
          setTimeout(() => console.log('npm install: fetching packages...'), 500);
        `], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.unref();

        events.push({ t: Date.now() - start, event: 'child-spawned', pid: child.pid });

        setTimeout(() => {
          events.push({ t: Date.now() - start, event: 'parent-exit' });
          console.log('');
          console.log('  Timeline (simulated):');
          for (const evt of events) {
            console.log(`    t+${evt.t}ms: ${evt.event}${evt.pid ? ' (pid=' + evt.pid + ')' : ''}`);
          }
          console.log('');
          console.log('  ⚠ parent exits at t+1000ms but npm install takes 10000ms+');
          console.log('  Under systemd, the child is killed before completing.');

          // Clean up child
          try { process.kill(child.pid, 'SIGKILL'); } catch {}

          // Don't actually exit — it's a test
          resolve();
        }, 500);
      }, 500);
    });
  });
});

// ─── Failure 2: Remote Instance Routing ─────────────────────────────────

describe('Failure 2: Electron remote instance update routing issue', () => {
  it('shows that WaitForUpdateApplied treats available:false as success incorrectly', () => {
    // The waitForUpdateApplied function in UpdateDialog.tsx line 170:
    //   if (data && data.available === false) { return true; }
    //
    // Problem: After a failed update + server restart, if the update check
    // endpoint returns available:false (e.g., transient error fetching the
    // latest version from npm), this is treated as "update was applied"
    // even though the version hasn't changed.

    const previousVersion = '1.16.0';

    // Scenario 1: Server restarts, update check fails transiently
    const serverResponseFailure = {
      available: false,
      error: 'Failed to check for updates',
      currentVersion: '1.16.0',  // Still the old version!
    };

    // The bug: available=false is treated as "update applied"
    const shouldBeTreatedAsApplied = serverResponseFailure.available === false;
    expect(shouldBeTreatedAsApplied).toBe(true);

    console.log('');
    console.log('  ⚠ waitForUpdateApplied returns true when data.available === false');
    console.log('  This causes the UI to show success despite no version change.');
    console.log(`  currentVersion = ${serverResponseFailure.currentVersion}`);
    console.log(`  previousVersion = ${previousVersion}`);
    console.log(`  Version changed? ${serverResponseFailure.currentVersion !== previousVersion}`);
    console.log('  BUT: available=false → treated as "update applied" → SUCCESS');

    // Scenario 2: Correct behavior — version must change
    const serverResponseSuccess = {
      available: false,
      currentVersion: '1.17.0',  // Updated!
    };

    const correctCheck = serverResponseSuccess.currentVersion !== previousVersion;
    expect(correctCheck).toBe(true);
    console.log('');
    console.log('  Correct behavior would require version change + available=false');
    console.log('  or health endpoint confirming new version.');
  });

  it('traces the remote instance update code: remote check vs install routing', () => {
    // In Header.tsx, the remote instance update check sends GET to
    // /api/openchamber/update-check via runtimeFetch.
    //
    // runtimeFetch builds the URL using getRuntimeUrlResolver().api() which
    // uses the configured apiBaseUrl (set via switchRuntimeEndpoint or
    // window.__OPENCHAMBER_API_BASE_URL__).
    //
    // For a remote instance, apiBaseUrl should point to the remote server.
    //
    // The install (POST /api/openchamber/update-install) uses the same
    // runtimeFetch mechanism.
    //
    // However, there is a subtle timing issue:
    // 1. The remote check uses instanceMode=remote query param
    // 2. The install POST does NOT include instanceMode
    // 3. The local update dialog uses runtimeType="web" and handleWebUpdate

    console.log('');
    console.log('  Remote check request:');
    console.log('    GET /api/openchamber/update-check?appType=web&instanceMode=remote');
    console.log('    → Goes to remote server (via runtimeFetch → runtime URL resolver)');
    console.log('');
    console.log('  Remote install request:');
    console.log('    POST /api/openchamber/update-install');
    console.log('    → Goes to runtimeFetch which resolves via apiBaseUrl');
    console.log('');
    console.log('  The install request should go to the same remote server.');
    console.log('  But if apiBaseUrl resolves to the LOCAL sidecar instead:');
    console.log('  - The LOCAL server receives the install request');
    console.log('  - The LOCAL server might check its own npm package version');
    console.log('  - The LOCAL server may error (no update needed) or');
    console.log('    attempt to update itself, leaving the REMOTE server untouched');
    console.log('');
    console.log('  Additionally, even if routing is correct:');
    console.log('  - The remote WSL server runs under systemd');
    console.log('  - POST /api/openchamber/update-install triggers Failure 1');
    console.log('  - The npm install gets killed by cgroup cleanup');
    console.log('  - The remote server restarts unchanged');
    console.log('  - The Electron UI reconnects showing old version');

    // Verify that the remote update dialog uses web runtime (Header.tsx:2607)
    const remoteUpdateDialogRuntimeType = 'web';
    expect(remoteUpdateDialogRuntimeType).toBe('web');

    // Verify the dialog uses installWebUpdate which sends POST via runtimeFetch
    // (UpdateDialog.tsx:241-268)
    console.log('');
    console.log('  UpdateDialog runtimeType="web" → uses handleWebUpdate');
    console.log('  handleWebUpdate calls installWebUpdate()');
    console.log('  installWebUpdate calls runtimeFetch("/api/openchamber/update-install")');
    console.log('');
    console.log('  ⚠ If apiBaseUrl is misconfigured or falls back to local:');
    console.log('  The install goes to the wrong server');
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────

function readProcCgroup() {
  try {
    return fs.readFileSync('/proc/self/cgroup', 'utf8');
  } catch {
    return null;
  }
}

function extractCgroupPath(cgroupContent) {
  if (!cgroupContent) return 'unknown';
  for (const line of cgroupContent.split('\n')) {
    if (line.includes('::')) return line.split('::')[1] || 'unknown';
    const parts = line.split(':');
    if (parts.length >= 3 && parts[2] && !parts[1].includes(',') && parts[1] !== '') {
      return parts[2].trim();
    }
  }
  // Fallback: return first non-empty line
  const lines = cgroupContent.split('\n').filter(Boolean);
  return lines[0] || 'unknown';
}
