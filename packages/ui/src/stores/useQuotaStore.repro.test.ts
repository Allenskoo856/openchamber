/**
 * Reproduction test for issue #2416:
 * Mobile usage panel keeps stale provider quotas.
 *
 * Root cause: MobileSessionMetadataButton (in MobileApp.tsx lines 1756-1763)
 * only refreshes quota data when opening the panel if at least one configured
 * provider is MISSING from the local store results. Once all providers have
 * results (even if those results are stale), reopening the panel does NOT
 * trigger a new fetch. With auto-refresh disabled (the default), stale reset
 * windows and remaining percentages persist indefinitely.
 *
 * Expected behavior: opening the panel should always refresh stale quota data
 * while preserving current values until the request completes.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { useQuotaStore } from './useQuotaStore';
import type { ProviderResult, QuotaProviderId } from '@/types';

// Helper to create stale quota results
function createStaleResult(providerId: QuotaProviderId, minutesAgo: number): ProviderResult {
  const now = Date.now();
  return {
    providerId,
    providerName: providerId,
    ok: true,
    configured: true,
    usage: {
      windows: {
        '5h': {
          usedPercent: 45,
          remainingPercent: 55,
          windowSeconds: 18000,
          resetAfterSeconds: 7200,
          resetAt: now + 7200000,
          resetAtFormatted: 'in 2 hours',
          resetAfterFormatted: '2 hours',
        },
      },
    },
    fetchedAt: now - minutesAgo * 60 * 1000,
  };
}

describe('Issue #2416 - Mobile usage panel keeps stale provider quotas', () => {
  beforeEach(() => {
    // Reset the quota store to initial state (no results, no settings)
    useQuotaStore.setState({
      results: [],
      isLoading: false,
      isFetchingProvider: {},
      lastUpdated: null,
      error: null,
      autoRefresh: false,
      refreshIntervalMs: 60000,
      displayMode: 'usage',
      showPredValues: false,
      dropdownProviderIds: ['openai' as QuotaProviderId, 'claude' as QuotaProviderId],
      selectedModels: {},
      expandedFamilies: {},
    });
  });

  function simulatePanelOpen(shouldCallFetch: () => void) {
    const state = useQuotaStore.getState();
    if (state.isLoading) return;
    const missingEnabledProvider = state.dropdownProviderIds.some((providerId) => (
      !state.results.some((result) => result.providerId === providerId)
    ));
    if (!missingEnabledProvider) return; // ❌ This is the bug: no fetch even when stale
    // This is what the real useEffect does when the condition passes:
    const fetchFn = useQuotaStore.getState().fetchAllQuotas;
    fetchFn();
    shouldCallFetch();
  }

  test('opening panel with stale data does NOT trigger fetch when all providers have results', () => {
    // Arrange: store already has stale results from a previous fetch
    const staleResults: ProviderResult[] = [
      createStaleResult('openai' as QuotaProviderId, 30),   // 30 min old
      createStaleResult('claude' as QuotaProviderId, 30),    // 30 min old
    ];
    useQuotaStore.setState({ results: staleResults });

    let fetchCalled = false;
    const originalFetch = useQuotaStore.getState().fetchAllQuotas;
    useQuotaStore.setState({
      fetchAllQuotas: async () => {
        fetchCalled = true;
      },
    });

    // Act: simulate opening the panel (with all providers present)
    simulatePanelOpen(() => { /* fetch would be called — but it won't reach here */ });

    // Assert: fetch was NOT called because all providers already have results
    expect(fetchCalled).toBe(false);
    // The stale results remain unchanged
    expect(useQuotaStore.getState().results[0].fetchedAt).toBe(staleResults[0].fetchedAt);

    // Restore original
    useQuotaStore.setState({ fetchAllQuotas: originalFetch });
  });

  test('fetch IS triggered when a provider is missing from results (first open)', () => {
    // Arrange: only one provider has results, one is missing
    const partialResults: ProviderResult[] = [
      createStaleResult('openai' as QuotaProviderId, 30),
    ];
    useQuotaStore.setState({ results: partialResults });

    let fetchCalled = false;
    const originalFetch = useQuotaStore.getState().fetchAllQuotas;
    useQuotaStore.setState({
      fetchAllQuotas: async () => {
        fetchCalled = true;
      },
    });

    // Act: simulate opening the panel (claude is missing from results)
    simulatePanelOpen(() => { /* fetch will be called */ });

    // Assert: fetch WAS called because 'claude' is missing from results
    expect(fetchCalled).toBe(true);

    // Restore original
    useQuotaStore.setState({ fetchAllQuotas: originalFetch });
  });

  test('stale data persists across panel toggle cycles with auto-refresh off', () => {
    // Initial fetch — get some data
    const initialResults: ProviderResult[] = [
      createStaleResult('openai' as QuotaProviderId, 0),  // fresh
      createStaleResult('claude' as QuotaProviderId, 0),   // fresh
    ];
    useQuotaStore.setState({ results: initialResults, lastUpdated: Date.now() });

    let fetchCallCount = 0;
    const originalFetch = useQuotaStore.getState().fetchAllQuotas;
    useQuotaStore.setState({
      fetchAllQuotas: async () => {
        fetchCallCount++;
      },
    });

    // Open panel — already has all providers (stale data scenario)
    simulatePanelOpen(() => {});
    expect(fetchCallCount).toBe(0); // No fetch because all providers present

    // Close and reopen panel (simulating toggle)
    simulatePanelOpen(() => {});
    expect(fetchCallCount).toBe(0); // Still no fetch — stale data remains

    // Make data even older (simulating time passing while panel is closed)
    useQuotaStore.setState({
      results: useQuotaStore.getState().results.map(r => ({
        ...r,
        fetchedAt: r.fetchedAt - 3600000, // make it 1 hour older
        usage: r.usage ? {
          windows: {
            '5h': {
              ...r.usage.windows['5h'],
              resetAtFormatted: '1 hour ago', // stale display text
            },
          },
        } : null,
      })),
    });

    // Open panel yet again — data is now very stale
    simulatePanelOpen(() => {});
    expect(fetchCallCount).toBe(0); // ❌ Still no fetch — stale data persists forever

    // Restore
    useQuotaStore.setState({ fetchAllQuotas: originalFetch });
  });

  test('auto-refresh is disabled by default', () => {
    expect(useQuotaStore.getState().autoRefresh).toBe(false);
  });
});
