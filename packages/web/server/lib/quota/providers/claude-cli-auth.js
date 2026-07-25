/**
 * Read Claude Code CLI subscription OAuth access token for Usage probes.
 * Never log or return credential file contents beyond the access token value
 * needed for the Anthropic usage request.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {string} [homeDir]
 * @returns {string[]}
 */
export function listClaudeCredentialsCandidates(homeDir = os.homedir()) {
  return [
    path.join(homeDir, '.claude', '.credentials.json'),
    path.join(homeDir, '.claude', 'credentials.json'),
    path.join(homeDir, '.config', 'claude', '.credentials.json'),
  ];
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
 *   readFile?: (path: string, encoding: BufferEncoding) => string,
 *   existsSync?: (path: string) => boolean,
 * }} [options]
 * @returns {string | null}
 */
export function readClaudeCliOAuthAccessToken(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const readFile = options.readFile || ((filePath, encoding) => fs.readFileSync(filePath, encoding));
  const existsSync = options.existsSync || ((filePath) => fs.existsSync(filePath));

  for (const candidate of listClaudeCredentialsCandidates(homeDir)) {
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
 * True when a Claude CLI credentials file contains a non-empty OAuth access token.
 * Does not return or log the token.
 *
 * @param {{
 *   homeDir?: string,
 *   readFile?: (path: string, encoding: BufferEncoding) => string,
 *   existsSync?: (path: string) => boolean,
 * }} [options]
 * @returns {boolean}
 */
export function hasClaudeCliOAuthCredentials(options = {}) {
  return Boolean(readClaudeCliOAuthAccessToken(options));
}
