/**
 * Reproduction script for issue #2544:
 * EPERM: operation not permitted, rename on settings.json prevents startup (Windows)
 *
 * This script demonstrates the root cause and validates the fix approach.
 *
 * The bug:
 *   Electron's writeJsonFile (packages/electron/main.mjs lines 513-524) performs an
 *   atomic rename via fsp.rename(tmp, filePath). On Windows with filesystem filter
 *   drivers (App-V, WdFilter, bindflt, CldFlt, etc.), MoveFileExW with
 *   MOVEFILE_REPLACE_EXISTING fails with EPERM. The function has no fallback.
 *
 *   In contrast, settings-runtime.js's replaceFile (lines 474-501) retries transient
 *   Windows errors (EPERM/EACCES/EBUSY) and falls back to copyFile + rm when rename
 *   consistently fails.
 *
 *   The Electron version lacks this retry/fallback logic entirely.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = path.join(__dirname, '.repro-tmp-2544');
const SETTINGS_PATH = path.join(TMP_DIR, 'settings.json');

// ── Simulated Windows EPERM on rename ──────────────────────────────────────
//
// On Windows with filter drivers, fs.rename (→ MoveFileExW with
// MOVEFILE_REPLACE_EXISTING) fails with EPERM when the target already exists.
// This mock replicates that behavior so we can reproduce the bug on Linux.

const originalRename = fsp.rename;
let simulateEpermOnExistingTarget = false;

fsp.rename = async function mockedRename(src, dest) {
  if (simulateEpermOnExistingTarget) {
    // Check if destination exists BEFORE attempting the rename.
    // We want to simulate the Windows behavior where rename fails
    // with EPERM when replacing an existing file, but works when
    // creating a new file (dest doesn't exist yet).
    const destExists = await fsp.access(dest).then(() => true, () => false);
    if (destExists) {
      const err = new Error('EPERM: operation not permitted, rename');
      err.code = 'EPERM';
      err.errno = -4048;
      err.syscall = 'rename';
      err.path = src;
      err.dest = dest;
      throw err;
    }
    // If dest doesn't exist, let it proceed (rename-to-new works fine per the issue)
    return originalRename.call(fsp, src, dest);
  }
  return originalRename.call(fsp, src, dest);
};

// ── Electron's writeJsonFile (exact code from main.mjs lines 513-524) ─────

const electronWriteJsonFile = async (filePath, data) => {
  const directory = path.dirname(filePath);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fsp.chmod(directory, 0o700);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') await fsp.chmod(tmp, 0o600);
  await fsp.rename(tmp, filePath);  // <── LINE 522: FAILS with EPERM on Windows
  if (process.platform !== 'win32') await fsp.chmod(filePath, 0o600);
};

// ── settings-runtime.js replaceFile (adapted from lines 467-501) ──────────

const isTransientWindowsReplaceError = (error) => {
  return error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY';
};

const replaceFileWithFallback = async (tmp, target) => {
  const maxAttempts = 6;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await fsp.rename(tmp, target);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientWindowsReplaceError(error) || attempt === maxAttempts) {
        break;
      }
      await new Promise((r) => setTimeout(r, 25 * attempt));
    }
  }

  if (!isTransientWindowsReplaceError(lastError)) {
    throw lastError;
  }

  // Fallback: copyFile + rm when rename consistently fails on Windows
  await fsp.copyFile(tmp, target);
  await fsp.rm(tmp, { force: true });
};

const fixedWriteJsonFile = async (filePath, data) => {
  const directory = path.dirname(filePath);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fsp.chmod(directory, 0o700);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') await fsp.chmod(tmp, 0o600);
  await replaceFileWithFallback(tmp, filePath);  // <── uses retry + fallback
  if (process.platform !== 'win32') await fsp.chmod(filePath, 0o600);
};

// ── Test harness ───────────────────────────────────────────────────────────

const reset = async () => {
  await fsp.rm(TMP_DIR, { recursive: true, force: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
};

const testLabel = (label) => {
  console.log(`\n━━ ${label} ━━`);
};

const assertContent = async (expected) => {
  const raw = await fsp.readFile(SETTINGS_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const ok = parsed.value === expected;
  console.log(`  content check (${expected}): ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) console.log(`    expected value=${expected}, got value=${parsed.value}`);
  return ok;
};

let allPassed = true;
const check = (ok, msg) => {
  if (!ok) {
    console.log(`  ❌ ${msg}`);
    allPassed = false;
  } else {
    console.log(`  ✓ ${msg}`);
  }
};

// ── Test 1: First write (no existing file) with Electron code ─────────────

testLabel('1: First write (no existing file) — Electron code');
await reset();
simulateEpermOnExistingTarget = true;
await electronWriteJsonFile(SETTINGS_PATH, { value: 1 });
check(await assertContent(1), 'First write succeeds');

// ── Test 2: Second write (existing file) with Electron code ───────────────

testLabel('2: Second write (EPERM on rename) — Electron code (BUG)');
// File already exists from Test 1
try {
  await electronWriteJsonFile(SETTINGS_PATH, { value: 2 });
  check(false, 'Should have thrown EPERM but succeeded (bug not reproduced)');
} catch (error) {
  check(
    error.code === 'EPERM',
    `Got expected EPERM error (code=${error.code}): ${error.message}`
  );
  // Verify the original content is intact (the tmp rename failed, but tmp was
  // written — the file is not corrupted but the update was lost)
  await assertContent(1);
}

// ── Test 3: With the fix (retry + copyFile fallback) ─────────────────────

testLabel('3: Second write with fix (replaceFileWithFallback) — should succeed');
await reset();
simulateEpermOnExistingTarget = true;
await fixedWriteJsonFile(SETTINGS_PATH, { value: 3 });
check(await assertContent(3), 'Fixed write succeeds despite EPERM on rename');

// Also test a third write while EPERM is still active
await fixedWriteJsonFile(SETTINGS_PATH, { value: 4 });
check(await assertContent(4), 'Third write also succeeds with the fix');

// ── Summary ───────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════════════');
if (allPassed) {
  console.log('SUCCESS: Reproduction confirms the bug and fix approach.');
} else {
  console.log('SOME CHECKS FAILED');
}
console.log('\nRoot cause: Electron main.mjs writeJsonFile (line 522) calls');
console.log('fsp.rename(tmp, filePath) without retry or copyFile fallback for');
console.log('Windows transient EPERM/EACCES/EBUSY errors.');
console.log('\nFix: Adopt the replaceFile pattern from settings-runtime.js (lines');
console.log('467-501) which retries transient errors and falls back to');
console.log('copyFile + rm when rename consistently fails.');

// Restore original
fsp.rename = originalRename;
await fsp.rm(TMP_DIR, { recursive: true, force: true });

process.exit(allPassed ? 0 : 1);
