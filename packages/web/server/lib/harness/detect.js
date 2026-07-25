/**
 * Harness runtime detection: binary presence + best-effort login probe.
 * Failure must never masquerade as ready with an empty catalog.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CLAUDE_CODE_MODELS,
  getHarnessDescriptor,
  isKnownHarnessId,
  listHarnessDescriptors,
} from './registry.js';
import { probeClaudeAgentSdk } from './translators/claude-code/query.js';
import { buildClaudeCodeChildEnv } from './translators/claude-code/auth-env.js';

/**
 * @param {string} binaryName
 * @param {string} [searchPath]
 * @returns {string | null}
 */
export function findBinaryOnPath(binaryName, searchPath = process.env.PATH || '') {
  const trimmed = typeof binaryName === 'string' ? binaryName.trim() : '';
  if (!trimmed) return null;

  const parts = searchPath.split(path.delimiter).filter(Boolean);
  const candidateNames = [];

  if (process.platform === 'win32' && !path.extname(trimmed)) {
    const pathExt = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
    for (const ext of pathExt.split(';')) {
      const normalizedExt = ext.trim();
      if (!normalizedExt) continue;
      const candidateName = `${trimmed}${normalizedExt.startsWith('.') ? normalizedExt : `.${normalizedExt}`}`;
      if (!candidateNames.some((existing) => existing.toLowerCase() === candidateName.toLowerCase())) {
        candidateNames.push(candidateName);
      }
    }
  }
  candidateNames.push(trimmed);

  for (const dir of parts) {
    for (const candidateName of candidateNames) {
      const candidate = path.join(dir, candidateName);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // continue
      }
    }
  }
  return null;
}

/**
 * Best-effort Claude subscription login probe (no secrets returned).
 * @param {{ homeDir?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ loggedIn: boolean, detail?: string }}
 */
export function probeClaudeLogin(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const candidates = [
    path.join(homeDir, '.claude', '.credentials.json'),
    path.join(homeDir, '.claude', 'credentials.json'),
    path.join(homeDir, '.config', 'claude', '.credentials.json'),
    path.join(homeDir, '.claude.json'),
  ];

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const stat = fs.statSync(candidate);
      if (!stat.isFile() || stat.size <= 0) continue;
      // Presence of a non-empty credentials file is a best-effort signal.
      // Do not read or return contents.
      return { loggedIn: true, detail: 'credentials-file-present' };
    } catch {
      // continue
    }
  }

  return { loggedIn: false, detail: 'no-credentials-file' };
}

/**
 * @param {string} binaryPath
 * @returns {string | undefined}
 */
function probeClaudeVersion(binaryPath) {
  try {
    const result = spawnSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      timeout: 4000,
      env: buildClaudeCodeChildEnv(),
      windowsHide: true,
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (!output) return undefined;
    const match = output.match(/(\d+\.\d+\.\d+[\w.-]*)/);
    return match?.[1] || output.split('\n')[0]?.slice(0, 80);
  } catch {
    return undefined;
  }
}

/**
 * @param {object} [options]
 * @param {() => string | null} [options.findClaudeBinary]
 * @param {() => { loggedIn: boolean, detail?: string }} [options.probeLogin]
 * @param {() => Promise<{ available: boolean, error?: string }>} [options.probeSdk]
 * @param {boolean} [options.openCodeReady]
 * @returns {Promise<object>}
 */
export async function detectClaudeCode(options = {}) {
  const findClaudeBinary = options.findClaudeBinary
    || (() => findBinaryOnPath('claude'));
  const probeLogin = options.probeLogin || (() => probeClaudeLogin());
  const probeSdk = options.probeSdk || (() => probeClaudeAgentSdk());
  const descriptor = getHarnessDescriptor('claude-code');

  try {
    const binaryPath = findClaudeBinary();
    if (!binaryPath) {
      return {
        engine: descriptor,
        status: 'missing-cli',
        statusDetail: 'Claude CLI (`claude`) was not found on PATH',
        sections: [],
      };
    }

    const sdk = await probeSdk();
    if (!sdk.available) {
      return {
        engine: descriptor,
        status: 'error',
        statusDetail: sdk.error || 'Claude Agent SDK is unavailable',
        version: probeClaudeVersion(binaryPath),
        sections: [],
      };
    }

    const login = probeLogin();
    const version = probeClaudeVersion(binaryPath);

    if (!login.loggedIn) {
      return {
        engine: descriptor,
        status: 'needs-login',
        statusDetail: 'Claude Code subscription login was not detected. Run `claude` and sign in, then re-detect.',
        version,
        sections: [{
          id: 'models',
          name: 'Models',
          kind: 'models',
          models: [...CLAUDE_CODE_MODELS],
        }],
      };
    }

    return {
      engine: descriptor,
      status: 'ready',
      statusDetail: undefined,
      version,
      sections: [{
        id: 'models',
        name: 'Models',
        kind: 'models',
        models: [...CLAUDE_CODE_MODELS],
      }],
    };
  } catch (error) {
    return {
      engine: descriptor,
      status: 'error',
      statusDetail: error instanceof Error ? error.message : 'Claude Code detect failed',
      sections: [],
    };
  }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.openCodeReady]
 * @returns {object}
 */
export function detectOpenCode(options = {}) {
  const descriptor = getHarnessDescriptor('opencode');
  const ready = options.openCodeReady !== false;
  return {
    engine: descriptor,
    status: ready ? 'ready' : 'error',
    statusDetail: ready ? undefined : 'OpenCode lifecycle is not ready',
    sections: [],
  };
}

/**
 * @param {string} harnessId
 * @param {object} [options]
 * @returns {Promise<object | null>}
 */
export async function detectHarness(harnessId, options = {}) {
  if (!isKnownHarnessId(harnessId)) return null;
  if (harnessId === 'opencode') return detectOpenCode(options);
  if (harnessId === 'claude-code') return detectClaudeCode(options);
  return null;
}

/**
 * @param {object} [options]
 * @returns {Promise<object[]>}
 */
export async function detectAllHarnesses(options = {}) {
  const results = [];
  for (const descriptor of listHarnessDescriptors()) {
    const detected = await detectHarness(descriptor.id, options);
    if (detected) results.push(detected);
  }
  return results;
}
