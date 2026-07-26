/**
 * Read Claude Code CLI subscription OAuth access token for Usage probes.
 * Never log or return credential file contents beyond the access token value
 * needed for the Anthropic usage request.
 *
 * Resolution order:
 * 1. `CLAUDE_CODE_OAUTH_TOKEN` env (Cursor Use Environment / CI secrets)
 * 2. Credentials files under `CLAUDE_CONFIG_DIR` or `$HOME/.claude` / `.config/claude`
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Non-empty `CLAUDE_CODE_OAUTH_TOKEN` from env (subscription OAuth for automated hosts).
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
export function readClaudeCodeOAuthTokenFromEnv(env = process.env) {
  const value = env?.CLAUDE_CODE_OAUTH_TOKEN;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * @param {string} [homeDir]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function listClaudeCredentialsCandidates(homeDir = os.homedir(), env = process.env) {
  const candidates = [];
  const configDir = typeof env?.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  if (configDir) {
    candidates.push(path.join(configDir, '.credentials.json'));
    candidates.push(path.join(configDir, 'credentials.json'));
  }
  candidates.push(
    path.join(homeDir, '.claude', '.credentials.json'),
    path.join(homeDir, '.claude', 'credentials.json'),
    path.join(homeDir, '.config', 'claude', '.credentials.json'),
  );
  return candidates;
}

/**
 * Extract a non-empty OAuth access token from a credentials JSON object.
 * Supports camelCase (current CLI) and snake_case variants.
 *
 * @param {unknown} parsed
 * @returns {string | null}
 */
export function extractClaudeOAuthAccessToken(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const root = /** @type {Record<string, unknown>} */ (parsed);

  const camel = root.claudeAiOauth;
  if (camel && typeof camel === 'object') {
    const access = /** @type {Record<string, unknown>} */ (camel).accessToken;
    if (typeof access === 'string' && access.trim()) return access.trim();
  }

  const snake = root.claude_ai_oauth;
  if (snake && typeof snake === 'object') {
    const access = /** @type {Record<string, unknown>} */ (snake).access_token
      ?? /** @type {Record<string, unknown>} */ (snake).accessToken;
    if (typeof access === 'string' && access.trim()) return access.trim();
  }

  return null;
}

/**
 * @param {{
 *   homeDir?: string,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   readFile?: (path: string, encoding: BufferEncoding) => string,
 *   existsSync?: (path: string) => boolean,
 * }} [options]
 * @returns {string | null}
 */
export function readClaudeCliOAuthAccessToken(options = {}) {
  const env = options.env || process.env;
  const fromEnv = readClaudeCodeOAuthTokenFromEnv(env);
  if (fromEnv) return fromEnv;

  const homeDir = options.homeDir || os.homedir();
  const readFile = options.readFile || ((filePath, encoding) => fs.readFileSync(filePath, encoding));
  const existsSync = options.existsSync || ((filePath) => fs.existsSync(filePath));

  for (const candidate of listClaudeCredentialsCandidates(homeDir, env)) {
    try {
      if (!existsSync(candidate)) continue;
      const raw = readFile(candidate, 'utf8');
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const parsed = JSON.parse(raw);
      const token = extractClaudeOAuthAccessToken(parsed);
      if (token) return token;
    } catch {
      // continue — malformed / unreadable files are not authoritative success
    }
  }

  return null;
}

/**
 * True when a Claude CLI credentials file or `CLAUDE_CODE_OAUTH_TOKEN` contains
 * a non-empty OAuth access token. Does not return or log the token.
 *
 * @param {{
 *   homeDir?: string,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   readFile?: (path: string, encoding: BufferEncoding) => string,
 *   existsSync?: (path: string) => boolean,
 * }} [options]
 * @returns {boolean}
 */
export function hasClaudeCliOAuthCredentials(options = {}) {
  return Boolean(readClaudeCliOAuthAccessToken(options));
}
