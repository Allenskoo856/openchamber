import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp
} from '../utils/index.js';
import { readClaudeCliOAuthAccessToken } from './claude-cli-auth.js';

export const providerId = 'claude';
export const providerName = 'Claude subscription';
const aliases = ['anthropic', 'claude'];

/**
 * Resolve a bearer token for Claude subscription usage windows.
 * Prefers Claude Code CLI OAuth (engine-aligned), then OpenCode auth.json.
 * Never logs token values.
 *
 * @returns {{ accessToken: string | null, source: 'claude-cli' | 'opencode-auth' | null }}
 */
function resolveClaudeUsageAccessToken() {
  const cliToken = readClaudeCliOAuthAccessToken();
  if (cliToken) {
    return { accessToken: cliToken, source: 'claude-cli' };
  }

  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const openCodeToken = entry?.access ?? entry?.token;
  if (typeof openCodeToken === 'string' && openCodeToken.trim()) {
    return { accessToken: openCodeToken.trim(), source: 'opencode-auth' };
  }

  return { accessToken: null, source: null };
}

export const isConfigured = () => {
  return Boolean(resolveClaudeUsageAccessToken().accessToken);
};

/**
 * @param {unknown} payload
 * @returns {Record<string, ReturnType<typeof toUsageWindow>>}
 */
export function mapClaudeUsageWindows(payload) {
  const windows = {};
  const fiveHour = payload?.five_hour ?? null;
  const sevenDay = payload?.seven_day ?? null;
  const sevenDaySonnet = payload?.seven_day_sonnet ?? null;
  const sevenDayOpus = payload?.seven_day_opus ?? null;

  if (fiveHour) {
    windows['5h'] = toUsageWindow({
      usedPercent: toNumber(fiveHour.utilization),
      windowSeconds: null,
      resetAt: toTimestamp(fiveHour.resets_at)
    });
  }
  if (sevenDay) {
    windows['7d'] = toUsageWindow({
      usedPercent: toNumber(sevenDay.utilization),
      windowSeconds: null,
      resetAt: toTimestamp(sevenDay.resets_at)
    });
  }
  if (sevenDaySonnet) {
    windows['7d-sonnet'] = toUsageWindow({
      usedPercent: toNumber(sevenDaySonnet.utilization),
      windowSeconds: null,
      resetAt: toTimestamp(sevenDaySonnet.resets_at)
    });
  }
  if (sevenDayOpus) {
    windows['7d-opus'] = toUsageWindow({
      usedPercent: toNumber(sevenDayOpus.utilization),
      windowSeconds: null,
      resetAt: toTimestamp(sevenDayOpus.resets_at)
    });
  }

  return windows;
}

export const fetchQuota = async () => {
  const { accessToken } = resolveClaudeUsageAccessToken();

  if (!accessToken) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20'
      }
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`
      });
    }

    const payload = await response.json();
    const windows = mapClaudeUsageWindows(payload);

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows }
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};
