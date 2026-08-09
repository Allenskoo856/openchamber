/**
 * Offline policy shared by the Electron shell and the in-process web server.
 *
 * The policy is intentionally fail-closed for public network destinations.
 * Loopback and private/link-local destinations remain available so an offline
 * desktop can talk to an intranet OpenAI-compatible endpoint or a local
 * service. `OPENCHAMBER_OFFLINE_ALLOWED_HOSTS` is an explicit escape hatch
 * for a hostname that an operator has verified as internal.
 */

const NETWORK_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);
const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on']);
const OFFLINE_ERROR_CODE = 'OPENCHAMBER_OFFLINE_MODE';
const OFFLINE_BLOCKED_ROUTE_PREFIXES = [
  '/api/openchamber/update-check',
  '/api/openchamber/update-install',
  '/api/openchamber/models-metadata',
  '/api/openchamber/tunnel',
  '/api/openchamber/relay/enable',
  '/api/openchamber/relay/pair',
  '/api/zen/models',
  '/api/opencode/upgrade',
  '/api/openchamber/realtime-proxy',
  '/api/github',
  '/api/quota',
  '/api/push',
  '/api/config/skills/catalog/source',
  '/api/config/skills/scan',
  '/api/config/skills/install',
];

const normalizeHost = (value) => String(value || '').trim().toLowerCase().replace(/\.$/, '');

const parseIpv4 = (host) => {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((part) => part < 0 || part > 255)) return null;
  return numbers;
};

const isPrivateIpv4 = (host) => {
  const parts = parseIpv4(host);
  if (!parts) return false;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
};

const isPrivateIpv6 = (host) => {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb');
};

const readAllowedHosts = (environment) => {
  const raw = typeof environment.OPENCHAMBER_OFFLINE_ALLOWED_HOSTS === 'string'
    ? environment.OPENCHAMBER_OFFLINE_ALLOWED_HOSTS
    : '';
  return raw
    .split(',')
    .map((entry) => normalizeHost(entry))
    .filter(Boolean);
};

const isExplicitlyAllowedHost = (host, allowedHosts) => allowedHosts.some((entry) => {
  if (entry.startsWith('*.')) return host.endsWith(entry.slice(1));
  return host === entry;
});

const isPrivateOrLocalHost = (host) => {
  const normalized = normalizeHost(host);
  if (!normalized) return false;
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (isPrivateIpv4(normalized) || isPrivateIpv6(normalized)) return true;
  if (!normalized.includes('.')) return true;
  return normalized.endsWith('.local')
    || normalized.endsWith('.lan')
    || normalized.endsWith('.internal')
    || normalized.endsWith('.intranet');
};

export const isOfflineModeEnabled = (environment = process.env) => {
  const values = [
    environment.OPENCHAMBER_OFFLINE_MODE,
    environment.OPENCHAMBER_DISABLE_EXTERNAL_NETWORK,
  ];
  return values.some((value) => TRUTHY_VALUES.has(String(value || '').trim().toLowerCase()));
};

export const isOfflineAllowedUrl = (value, environment = process.env) => {
  let url;
  try {
    url = value instanceof URL ? value : new URL(String(value));
  } catch {
    return true;
  }

  if (!NETWORK_PROTOCOLS.has(url.protocol)) return true;
  if (isPrivateOrLocalHost(url.hostname)) return true;
  return isExplicitlyAllowedHost(normalizeHost(url.hostname), readAllowedHosts(environment));
};

export const shouldBlockExternalNetworkUrl = (value, environment = process.env) => {
  if (!isOfflineModeEnabled(environment)) return false;
  let url;
  try {
    url = value instanceof URL ? value : new URL(String(value));
  } catch {
    return false;
  }
  return NETWORK_PROTOCOLS.has(url.protocol) && !isOfflineAllowedUrl(url, environment);
};

export const createOfflineNetworkError = (operation = 'network request') => {
  const error = new Error(`Blocked ${operation}: OpenChamber offline mode permits only local or explicitly allowed network destinations.`);
  error.code = OFFLINE_ERROR_CODE;
  error.statusCode = 503;
  return error;
};

export const installOfflineFetchGuard = ({ fetchImpl = globalThis.fetch } = {}) => {
  if (typeof fetchImpl !== 'function' || globalThis.__OPENCHAMBER_OFFLINE_FETCH_GUARD__) return;

  const guardedFetch = async (input, init) => {
    const rawUrl = typeof input === 'string' || input instanceof URL
      ? input
      : input?.url;
    if (shouldBlockExternalNetworkUrl(rawUrl)) {
      throw createOfflineNetworkError(`fetch to ${rawUrl}`);
    }
    return fetchImpl(input, init);
  };

  globalThis.fetch = guardedFetch;
  globalThis.__OPENCHAMBER_OFFLINE_FETCH_GUARD__ = true;
};

export const registerOfflineNetworkGuard = (app) => {
  app.use((req, res, next) => {
    if (!isOfflineModeEnabled()) {
      next();
      return;
    }

    const requestUrl = typeof req.originalUrl === 'string' ? req.originalUrl : req.url;
    const absoluteUrl = new URL(requestUrl || '/', 'http://127.0.0.1');
    const routePath = absoluteUrl.pathname;
    const isBlockedFeatureRoute = OFFLINE_BLOCKED_ROUTE_PREFIXES.some((prefix) => (
      routePath === prefix || routePath.startsWith(`${prefix}/`)
    ));
    if (isBlockedFeatureRoute || shouldBlockExternalNetworkUrl(absoluteUrl)) {
      res.status(503).json({
        error: 'This network operation is disabled in OpenChamber offline mode.',
        code: OFFLINE_ERROR_CODE,
      });
      return;
    }
    next();
  });
};

export const OFFLINE_NETWORK_ERROR_CODE = OFFLINE_ERROR_CODE;
