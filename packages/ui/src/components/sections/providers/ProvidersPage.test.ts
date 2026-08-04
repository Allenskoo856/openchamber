import { describe, expect, test } from 'bun:test';
import { listConnectableProviders, shouldLoadAvailableProviders } from './providerAvailability';

describe('ProvidersPage available provider loading', () => {
  test('loads available providers only in add-provider mode', () => {
    expect(shouldLoadAvailableProviders(false)).toBe(false);
    expect(shouldLoadAvailableProviders(true)).toBe(true);
  });
});

describe('listConnectableProviders', () => {
  const connected = (...ids: string[]) => new Set(ids);

  test('offers a plugin provider that only advertises auth methods', () => {
    const result = listConnectableProviders({
      catalog: [{ id: 'openai', name: 'OpenAI' }],
      authProviderIds: ['openai', 'cursor'],
      connectedIds: connected(),
    });

    expect(result.map((provider) => provider.id)).toEqual(['cursor', 'openai']);
    expect(result.find((provider) => provider.id === 'cursor')).toEqual({ id: 'cursor' });
  });

  test('excludes already connected providers from both sources', () => {
    const result = listConnectableProviders({
      catalog: [{ id: 'openai', name: 'OpenAI' }, { id: 'google', name: 'Google' }],
      authProviderIds: ['cursor', 'openai'],
      connectedIds: connected('google', 'cursor'),
    });

    expect(result.map((provider) => provider.id)).toEqual(['openai']);
  });

  test('keeps the catalog name when a provider appears in both sources', () => {
    const result = listConnectableProviders({
      catalog: [{ id: 'github-copilot', name: 'GitHub Copilot' }],
      authProviderIds: ['github-copilot'],
      connectedIds: connected(),
    });

    expect(result).toEqual([{ id: 'github-copilot', name: 'GitHub Copilot' }]);
  });

  test('sorts by display label and de-duplicates ids', () => {
    const result = listConnectableProviders({
      catalog: [
        { id: 'zzz', name: 'Alpha' },
        { id: 'aaa', name: 'Zeta' },
        { id: 'zzz', name: 'Duplicate' },
      ],
      authProviderIds: ['middle'],
      connectedIds: connected(),
    });

    expect(result.map((provider) => provider.name || provider.id)).toEqual(['Alpha', 'middle', 'Zeta']);
  });

  test('returns nothing when every known provider is connected', () => {
    const result = listConnectableProviders({
      catalog: [{ id: 'openai' }],
      authProviderIds: ['openai'],
      connectedIds: connected('openai'),
    });

    expect(result).toEqual([]);
  });
});
