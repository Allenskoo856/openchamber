import { describe, expect, test } from 'bun:test';
import { shouldLoadAvailableProviders } from './providerAvailability';
import {
  hasOauthAuthMethod,
  isOauthOnlyAuthMethods,
  normalizeAuthType,
  oauthMethodIndexes,
  shouldShowApiKeyField,
} from './providerAuth';

describe('ProvidersPage available provider loading', () => {
  test('loads available providers only in add-provider mode', () => {
    expect(shouldLoadAvailableProviders(false)).toBe(false);
    expect(shouldLoadAvailableProviders(true)).toBe(true);
  });
});

describe('provider auth method helpers', () => {
  test('normalizeAuthType recognizes oauth and api from type or label', () => {
    expect(normalizeAuthType({ type: 'oauth' })).toBe('oauth');
    expect(normalizeAuthType({ type: 'api' })).toBe('api');
    expect(normalizeAuthType({ label: 'Login with Cursor' })).toBe('');
    expect(normalizeAuthType({ label: 'OAuth login' })).toBe('oauth');
    expect(normalizeAuthType({ name: 'API Key' })).toBe('api');
  });

  test('shouldShowApiKeyField is true for unknown/empty and explicit api methods', () => {
    expect(shouldShowApiKeyField([])).toBe(true);
    expect(shouldShowApiKeyField([{ type: 'oauth', label: 'Login with Cursor' }])).toBe(false);
    expect(shouldShowApiKeyField([{ type: 'api' }])).toBe(true);
    expect(shouldShowApiKeyField([{ type: 'oauth' }, { type: 'api' }])).toBe(true);
  });

  test('oauth-only detection and original method indexes', () => {
    const oauthOnly = [{ type: 'oauth', label: 'Login with Cursor' }];
    expect(hasOauthAuthMethod(oauthOnly)).toBe(true);
    expect(isOauthOnlyAuthMethods(oauthOnly)).toBe(true);
    expect(oauthMethodIndexes(oauthOnly)).toEqual([0]);

    const mixed = [{ type: 'api' }, { type: 'oauth', label: 'Login' }];
    expect(hasOauthAuthMethod(mixed)).toBe(true);
    expect(isOauthOnlyAuthMethods(mixed)).toBe(false);
    expect(shouldShowApiKeyField(mixed)).toBe(true);
    expect(oauthMethodIndexes(mixed)).toEqual([1]);

    expect(isOauthOnlyAuthMethods([])).toBe(false);
    expect(hasOauthAuthMethod([])).toBe(false);
  });
});
