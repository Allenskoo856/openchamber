/**
 * Thin wrapper around @anthropic-ai/claude-agent-sdk query()/interrupt.
 * Import failure is surfaced as unavailable — detect must not report ready.
 */

import { spawnSync } from 'node:child_process';
import { buildClaudeCodeChildEnv } from './auth-env.js';
import {
  assertClaudeWorkingDirectory,
  resolveClaudeCodeExecutable,
} from './executable-path.js';

let sdkModulePromise = null;
/** @type {Error | null} */
let sdkLoadError = null;
/** @type {typeof import('@anthropic-ai/claude-agent-sdk') | null} */
let sdkModule = null;

/**
 * @returns {Promise<typeof import('@anthropic-ai/claude-agent-sdk')>}
 */
export async function loadClaudeAgentSdk() {
  if (sdkModule) return sdkModule;
  if (sdkLoadError) throw sdkLoadError;
  if (!sdkModulePromise) {
    sdkModulePromise = import('@anthropic-ai/claude-agent-sdk')
      .then((mod) => {
        sdkModule = mod;
        return mod;
      })
      .catch((error) => {
        sdkLoadError = error instanceof Error
          ? error
          : new Error(String(error?.message || error || 'Failed to load Claude Agent SDK'));
        sdkModulePromise = null;
        throw sdkLoadError;
      });
  }
  return sdkModulePromise;
}

/**
 * Reset cached SDK load state (tests only).
 */
export function resetClaudeAgentSdkCache() {
  sdkModule = null;
  sdkModulePromise = null;
  sdkLoadError = null;
}

/**
 * @returns {{ available: boolean, error?: string }}
 */
export function getClaudeAgentSdkAvailability() {
  if (sdkModule) return { available: true };
  if (sdkLoadError) {
    return { available: false, error: sdkLoadError.message || 'Claude Agent SDK unavailable' };
  }
  return { available: false, error: 'Claude Agent SDK not loaded' };
}

/**
 * Best-effort probe whether the SDK package can be imported.
 * @returns {Promise<{ available: boolean, error?: string }>}
 */
export async function probeClaudeAgentSdk() {
  try {
    await loadClaudeAgentSdk();
    return { available: true };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : 'Claude Agent SDK unavailable',
    };
  }
}

/**
 * Tree-kill a process (and process group when possible).
 * @param {number | null | undefined} pid
 * @param {{ signal?: NodeJS.Signals, force?: boolean }} [options]
 */
export function killProcessTree(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const signal = options.signal || 'SIGTERM';
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 5000,
        windowsHide: true,
      });
    } catch {
      // best-effort
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    // process group may not exist
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }

  if (options.force) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // ignore
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }
}

/**
 * @typedef {object} ClaudeQueryHandle
 * @property {AsyncIterable<unknown>} stream
 * @property {() => Promise<void>} interrupt
 * @property {() => void} close
 * @property {() => number | null | undefined} getPid
 */

/**
 * Start a Claude Agent SDK query with subscription-only env.
 *
 * @param {object} params
 * @param {string | AsyncIterable<unknown>} params.prompt
 * @param {string} params.cwd
 * @param {string} [params.model]
 * @param {string} [params.resume]
 * @param {string} [params.permissionMode]
 * @param {(toolName: string, input: Record<string, unknown>, options: object) => Promise<object | null>} [params.canUseTool]
 * @param {Record<string, string | undefined>} [params.env]
 * @param {boolean} [params.includePartialMessages]
 * @param {(mod: typeof import('@anthropic-ai/claude-agent-sdk')) => unknown} [params.queryImpl]
 * @returns {Promise<ClaudeQueryHandle>}
 */
export async function startClaudeQuery(params) {
  const sdk = await loadClaudeAgentSdk();
  const queryFn = typeof params.queryImpl === 'function'
    ? params.queryImpl
    : sdk.query;

  if (typeof queryFn !== 'function') {
    const error = new Error('Claude Agent SDK query() is unavailable');
    error.code = 'CLAUDE_SDK_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }

  const env = buildClaudeCodeChildEnv(params.env || process.env);
  const cwd = assertClaudeWorkingDirectory(params.cwd);
  const pathToClaudeCodeExecutable = typeof params.pathToClaudeCodeExecutable === 'string'
    && params.pathToClaudeCodeExecutable.trim()
    ? params.pathToClaudeCodeExecutable.trim()
    : resolveClaudeCodeExecutable({ env });

  const options = {
    cwd,
    env,
    includePartialMessages: params.includePartialMessages !== false,
  };
  if (pathToClaudeCodeExecutable) {
    // Avoid Electron asar ENOTDIR when the SDK resolves a path inside app.asar.
    options.pathToClaudeCodeExecutable = pathToClaudeCodeExecutable;
  }
  if (typeof params.model === 'string' && params.model.trim()) {
    options.model = params.model.trim();
  }
  if (typeof params.resume === 'string' && params.resume.trim()) {
    options.resume = params.resume.trim();
  }
  if (typeof params.permissionMode === 'string' && params.permissionMode.trim()) {
    options.permissionMode = params.permissionMode.trim();
  }
  if (typeof params.canUseTool === 'function') {
    options.canUseTool = params.canUseTool;
  }

  let result;
  try {
    result = queryFn({
      prompt: params.prompt,
      options,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
    if (code === 'ENOTDIR' || /spawn.*ENOTDIR/i.test(message)) {
      const wrapped = new Error(
        'Claude Code executable path is not spawnable (ENOTDIR). '
        + 'Packaged Desktop must use PATH/`app.asar.unpacked` Claude CLI, not an `app.asar` path.',
      );
      wrapped.code = 'CLAUDE_SPAWN_ENOTDIR';
      wrapped.statusCode = 503;
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }

  let closed = false;
  const getPid = () => {
    if (result && typeof result === 'object' && 'pid' in result) {
      return result.pid;
    }
    return null;
  };

  const interrupt = async () => {
    if (result && typeof result.interrupt === 'function') {
      try {
        await result.interrupt();
      } catch {
        // fall through to tree-kill
      }
    }
    killProcessTree(getPid(), { signal: 'SIGTERM' });
  };

  const close = () => {
    if (closed) return;
    closed = true;
    killProcessTree(getPid(), { signal: 'SIGTERM', force: true });
    if (result && typeof result.return === 'function') {
      try {
        void result.return();
      } catch {
        // ignore
      }
    }
  };

  return {
    stream: result,
    interrupt,
    close,
    getPid,
  };
}
