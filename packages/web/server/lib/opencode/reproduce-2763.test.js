// Reproduction for https://github.com/openchamber/openchamber/issues/2763
//
// [Bug] OPENCODE_BINARY env var silently cleared by empty settings.opencodeBinary
//       -> spawn opencode ENOENT
//
// Scenario:
//   1. OPENCODE_BINARY is set in the environment to a valid opencode executable
//      (e.g. a Nix store path in a systemd user service) and opencode is NOT on PATH.
//   2. The persisted settings file contains "opencodeBinary": "" (the empty-string
//      "clear" sentinel).
//   3. applyOpencodeBinaryFromSettings() runs `delete process.env.OPENCODE_BINARY`,
//      so the externally-provided env var is destroyed. Resolution then falls back
//      to PATH search, which fails -> the managed server spawns bare "opencode"
//      -> `spawn opencode ENOENT`.
//
// The two tests below encode the EXPECTED behavior (env var honored); the first
// fails because the env var is deleted, the second fails because the spawned
// binary is "opencode" instead of the env path.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenCodeEnvRuntime } from './env-runtime.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })),
}));

const { createOpenCodeLifecycleRuntime } = await import('./lifecycle.js');

const originalOpencodeBinary = process.env.OPENCODE_BINARY;
const originalPath = process.env.PATH;
const originalResourcesPath = process.resourcesPath;
const originalBundledOpencodeCliDir = process.env.OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR;
const originalShell = process.env.SHELL;
const tempDirs = [];

const createTempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  spawnMock.mockReset();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (typeof originalOpencodeBinary === 'string') {
    process.env.OPENCODE_BINARY = originalOpencodeBinary;
  } else {
    delete process.env.OPENCODE_BINARY;
  }
  if (typeof originalPath === 'string') {
    process.env.PATH = originalPath;
  } else {
    delete process.env.PATH;
  }
  if (typeof originalBundledOpencodeCliDir === 'string') {
    process.env.OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR = originalBundledOpencodeCliDir;
  } else {
    delete process.env.OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR;
  }
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: originalResourcesPath,
  });
  if (typeof originalShell === 'string') {
    process.env.SHELL = originalShell;
  } else {
    delete process.env.SHELL;
  }
});

// Mimics the reporter's environment: OPENCODE_BINARY set to a valid executable,
// opencode NOT on PATH, no bundled CLI, empty home fallbacks.
const setupEnvBinaryScenario = () => {
  const binDir = createTempDir('openchamber-2763-bin-');
  const binary = path.join(binDir, 'opencode');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(binary, 0o755);

  const emptyPathDir = createTempDir('openchamber-2763-empty-path-');
  const emptyHome = createTempDir('openchamber-2763-empty-home-');

  process.env.OPENCODE_BINARY = binary;
  process.env.PATH = emptyPathDir;
  delete process.env.OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR;
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: undefined,
  });
  process.env.SHELL = path.join(emptyHome, 'no-shell');

  return { binary, emptyHome };
};

const createEnvRuntime = (settings, { emptyHome, state } = {}) => {
  const envState = state || {
    cachedLoginShellEnvSnapshot: null,
    resolvedOpencodeBinary: null,
    resolvedOpencodeBinarySource: null,
    useWslForOpencode: false,
    resolvedWslBinary: null,
    resolvedWslOpencodePath: null,
    resolvedWslDistro: null,
    resolvedNodeBinary: null,
    resolvedBunBinary: null,
    managedOpenCodeShellEnvSnapshot: null,
  };
  const runtime = createOpenCodeEnvRuntime({
    state: envState,
    normalizeDirectoryPath: (value) => value,
    readSettingsFromDiskMigrated: async () => settings,
    homedir: () => emptyHome || os.homedir(),
  });
  return { runtime, envState };
};

const createMockChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 12345;
  child.kill = vi.fn(() => {
    child.signalCode = 'SIGTERM';
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  });
  return child;
};

const createLifecycleRuntime = (overrides = {}) => createOpenCodeLifecycleRuntime({
  state: {
    openCodeWorkingDirectory: os.tmpdir(),
    openCodeProcess: null,
    openCodePort: null,
    openCodeBaseUrl: null,
    currentRestartPromise: null,
    isRestartingOpenCode: false,
    openCodeApiPrefix: '',
    openCodeApiPrefixDetected: false,
    openCodeApiDetectionTimer: null,
    lastOpenCodeError: null,
    isOpenCodeReady: false,
    openCodeNotReadySince: 0,
    isExternalOpenCode: false,
    isShuttingDown: false,
    healthCheckInterval: null,
    expressApp: null,
    useWslForOpencode: false,
    resolvedWslBinary: null,
    resolvedWslOpencodePath: null,
    resolvedWslDistro: null,
  },
  env: {
    ENV_CONFIGURED_OPENCODE_PORT: 45678,
    ENV_CONFIGURED_OPENCODE_HOST: null,
    ENV_EFFECTIVE_PORT: 3001,
    ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
    ENV_SKIP_OPENCODE_START: false,
  },
  syncToHmrState: vi.fn(),
  syncFromHmrState: vi.fn(),
  getOpenCodeAuthHeaders: () => ({}),
  buildOpenCodeUrl: (route) => `http://127.0.0.1:45678${route}`,
  waitForReady: vi.fn(async () => true),
  normalizeApiPrefix: vi.fn(() => ''),
  applyOpencodeBinaryFromSettings: vi.fn(async () => null),
  ensureOpencodeCliEnv: vi.fn(),
  ensureLocalOpenCodeServerPassword: vi.fn(async () => 'password'),
  resolveManagedOpenCodeLaunchSpec: vi.fn((binary) => ({ binary, args: [], wrapperType: null })),
  setOpenCodePort: vi.fn(() => {}),
  setDetectedOpenCodeApiPrefix: vi.fn(),
  setupProxy: vi.fn(),
  ensureOpenCodeApiPrefix: vi.fn(),
  clearResolvedOpenCodeBinary: vi.fn(),
  buildAugmentedPath: vi.fn(() => '/usr/bin:/bin'),
  buildManagedOpenCodePath: vi.fn(() => '/usr/bin:/bin'),
  getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({})),
  ...overrides,
});

describe('Reproduction of #2763 — empty settings.opencodeBinary clears OPENCODE_BINARY env var', () => {
  it('control: honors OPENCODE_BINARY when settings has no opencodeBinary key (env-runtime level)', async () => {
    const { binary, emptyHome } = setupEnvBinaryScenario();
    const { runtime } = createEnvRuntime({}, { emptyHome });

    await runtime.applyOpencodeBinaryFromSettings();

    // No opencodeBinary setting -> env var untouched.
    expect(process.env.OPENCODE_BINARY).toBe(binary);
    // ensureOpencodeCliEnv() resolves the env var path.
    expect(runtime.ensureOpencodeCliEnv()).toBe(binary);
  });

  it('keeps an externally-provided OPENCODE_BINARY when settings.opencodeBinary is "" (env-runtime level)', async () => {
    const { binary, emptyHome } = setupEnvBinaryScenario();
    const { runtime } = createEnvRuntime({ opencodeBinary: '' }, { emptyHome });

    await runtime.applyOpencodeBinaryFromSettings();

    // EXPECTED: the externally-provided env var must survive the settings apply.
    // ACTUAL (bug): it is silently deleted -> OPENCODE_BINARY becomes undefined.
    expect(process.env.OPENCODE_BINARY).toBe(binary);

    // EXPECTED: ensureOpencodeCliEnv() resolves to the env var path.
    // ACTUAL (bug): falls back to PATH search, which has no opencode -> null.
    const resolved = runtime.ensureOpencodeCliEnv();
    expect(resolved).toBe(binary);
  });

  it('control: spawns the env-var binary when settings has no opencodeBinary key (end-to-end)', async () => {
    const { binary, emptyHome } = setupEnvBinaryScenario();
    const { runtime: envRuntime } = createEnvRuntime({}, { emptyHome });

    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const lifecycle = createLifecycleRuntime({
      applyOpencodeBinaryFromSettings: (...args) => envRuntime.applyOpencodeBinaryFromSettings(...args),
      ensureOpencodeCliEnv: () => envRuntime.ensureOpencodeCliEnv(),
      resolveManagedOpenCodeLaunchSpec: (...args) => envRuntime.resolveManagedOpenCodeLaunchSpec(...args),
      state: {
        openCodeWorkingDirectory: emptyHome,
        openCodeProcess: null,
        openCodePort: null,
        openCodeBaseUrl: null,
        currentRestartPromise: null,
        isRestartingOpenCode: false,
        openCodeApiPrefix: '',
        openCodeApiPrefixDetected: false,
        openCodeApiDetectionTimer: null,
        lastOpenCodeError: null,
        isOpenCodeReady: false,
        openCodeNotReadySince: 0,
        isExternalOpenCode: false,
        isShuttingDown: false,
        healthCheckInterval: null,
        expressApp: null,
        useWslForOpencode: false,
        resolvedWslBinary: null,
        resolvedWslOpencodePath: null,
        resolvedWslDistro: null,
      },
    });

    await lifecycle.startOpenCode();
    const [spawnedBinary] = spawnMock.mock.calls[0];

    // No opencodeBinary setting -> the env-var path is spawned.
    expect(spawnedBinary).toBe(binary);
  });

  it('spawns the env-var binary, not bare "opencode", when settings.opencodeBinary is "" (end-to-end)', async () => {
    const { binary, emptyHome } = setupEnvBinaryScenario();
    const { runtime: envRuntime, envState } = createEnvRuntime({ opencodeBinary: '' }, { emptyHome });

    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const lifecycle = createLifecycleRuntime({
      // Wire the REAL env runtime resolution (as server/index.js does).
      applyOpencodeBinaryFromSettings: (...args) => envRuntime.applyOpencodeBinaryFromSettings(...args),
      ensureOpencodeCliEnv: () => envRuntime.ensureOpencodeCliEnv(),
      resolveManagedOpenCodeLaunchSpec: (...args) => envRuntime.resolveManagedOpenCodeLaunchSpec(...args),
      state: {
        openCodeWorkingDirectory: emptyHome,
        openCodeProcess: null,
        openCodePort: null,
        openCodeBaseUrl: null,
        currentRestartPromise: null,
        isRestartingOpenCode: false,
        openCodeApiPrefix: '',
        openCodeApiPrefixDetected: false,
        openCodeApiDetectionTimer: null,
        lastOpenCodeError: null,
        isOpenCodeReady: false,
        openCodeNotReadySince: 0,
        isExternalOpenCode: false,
        isShuttingDown: false,
        healthCheckInterval: null,
        expressApp: null,
        useWslForOpencode: false,
        resolvedWslBinary: null,
        resolvedWslOpencodePath: null,
        resolvedWslDistro: null,
      },
    });

    await lifecycle.startOpenCode();
    const [spawnedBinary] = spawnMock.mock.calls[0];

    // EXPECTED: the managed server spawns the env-var path (which exists).
    // ACTUAL (bug): the env var was deleted, so it spawns bare "opencode",
    // which is not on PATH -> `spawn opencode ENOENT`.
    expect(spawnedBinary).toBe(binary);
  });
});
