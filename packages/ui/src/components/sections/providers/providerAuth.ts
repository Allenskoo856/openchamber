export interface AuthMethodLike {
  type?: string;
  name?: string;
  label?: string;
  [key: string]: unknown;
}

export const normalizeAuthType = (method: AuthMethodLike): string => {
  const raw = typeof method.type === 'string' ? method.type : '';
  const label = `${method.name ?? ''} ${method.label ?? ''}`.toLowerCase();
  const merged = `${raw} ${label}`.toLowerCase();
  if (merged.includes('oauth')) return 'oauth';
  if (merged.includes('api')) return 'api';
  return raw.toLowerCase();
};

/** Show API key when methods are unknown/empty, or when an explicit api method exists. */
export const shouldShowApiKeyField = (methods: AuthMethodLike[]): boolean => {
  if (methods.length === 0) return true;
  return methods.some((method) => normalizeAuthType(method) === 'api');
};

export const hasOauthAuthMethod = (methods: AuthMethodLike[]): boolean =>
  methods.some((method) => normalizeAuthType(method) === 'oauth');

export const isOauthOnlyAuthMethods = (methods: AuthMethodLike[]): boolean =>
  methods.length > 0 && methods.every((method) => normalizeAuthType(method) === 'oauth');

/** Original index in the provider.auth() methods array (required by oauth.authorize). */
export const oauthMethodIndexes = (methods: AuthMethodLike[]): number[] =>
  methods
    .map((method, index) => (normalizeAuthType(method) === 'oauth' ? index : -1))
    .filter((index) => index >= 0);
