import { create } from 'zustand';
import type {
  GitHubAPI,
  GitHubPullRequestContextResult,
  GitHubRepoSelector,
} from '@/lib/api/types';

const PR_CONTEXT_TTL_MS = 30_000;
const PR_CONTEXT_MAX_ENTRIES = 20;

export const getPrContextKey = (directory: string, number: number): string =>
  `${directory}#${number}`;

type PrContextEntry = {
  result: GitHubPullRequestContextResult | null;
  /** Whether `result` was fetched with check details included. */
  hasCheckDetails: boolean;
  fetchedAt: number;
  isLoading: boolean;
  error: string | null;
};

type EnsureOptions = {
  includeCheckDetails?: boolean;
  sourceRepo?: GitHubRepoSelector | null;
  force?: boolean;
};

interface PrContextStoreState {
  entries: Record<string, PrContextEntry>;
  /**
   * Fetch (or reuse) the PR context for directory#number. Deduplicates
   * concurrent callers and serves a fresh-enough cached result; a
   * details-inclusive result satisfies detail-free requests.
   */
  ensure: (
    github: GitHubAPI,
    directory: string,
    number: number,
    options?: EnsureOptions,
  ) => Promise<GitHubPullRequestContextResult | null>;
  invalidate: (directory: string, number?: number) => void;
}

const createEntry = (): PrContextEntry => ({
  result: null,
  hasCheckDetails: false,
  fetchedAt: 0,
  isLoading: false,
  error: null,
});

const inFlight = new Map<string, Promise<GitHubPullRequestContextResult | null>>();

const boundEntries = (entries: Record<string, PrContextEntry>): Record<string, PrContextEntry> => {
  const all = Object.entries(entries);
  if (all.length <= PR_CONTEXT_MAX_ENTRIES) return entries;
  return Object.fromEntries(all
    .sort(([, left], [, right]) => right.fetchedAt - left.fetchedAt)
    .slice(0, PR_CONTEXT_MAX_ENTRIES));
};

export const usePrContextStore = create<PrContextStoreState>()((set, get) => ({
  entries: {},

  ensure: async (github, directory, number, options) => {
    const key = getPrContextKey(directory, number);
    const includeCheckDetails = options?.includeCheckDetails ?? false;

    const existing = get().entries[key];
    const isFresh = existing
      && existing.result
      && Date.now() - existing.fetchedAt < PR_CONTEXT_TTL_MS
      && (existing.hasCheckDetails || !includeCheckDetails);
    if (!options?.force && isFresh) {
      return existing.result;
    }

    // A detail-inclusive request in flight satisfies everyone; a detail-free
    // one only satisfies detail-free callers.
    const inFlightKey = `${key}::${includeCheckDetails ? 'details' : 'plain'}`;
    const detailedInFlight = inFlight.get(`${key}::details`);
    const pending = detailedInFlight ?? (includeCheckDetails ? null : inFlight.get(inFlightKey));
    if (pending && !options?.force) {
      return pending;
    }

    const request = (async (): Promise<GitHubPullRequestContextResult | null> => {
      set((state) => ({
        entries: {
          ...state.entries,
          [key]: { ...(state.entries[key] ?? createEntry()), isLoading: true, error: null },
        },
      }));
      try {
        const result = await github.prContext(directory, number, {
          includeDiff: false,
          includeCheckDetails,
          sourceRepo: options?.sourceRepo ?? null,
        });
        set((state) => ({
          entries: boundEntries({
            ...state.entries,
            [key]: {
              result,
              hasCheckDetails: includeCheckDetails,
              fetchedAt: Date.now(),
              isLoading: false,
              error: null,
            },
          }),
        }));
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load pull request context';
        set((state) => ({
          entries: {
            ...state.entries,
            [key]: { ...(state.entries[key] ?? createEntry()), isLoading: false, error: message },
          },
        }));
        return null;
      } finally {
        inFlight.delete(inFlightKey);
      }
    })();

    inFlight.set(inFlightKey, request);
    return request;
  },

  invalidate: (directory, number) => {
    set((state) => {
      const next: Record<string, PrContextEntry> = {};
      const prefix = `${directory}#`;
      for (const [key, entry] of Object.entries(state.entries)) {
        const matches = number == null
          ? key.startsWith(prefix)
          : key === getPrContextKey(directory, number);
        if (!matches) {
          next[key] = entry;
        }
      }
      return { entries: next };
    });
  },
}));
