import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { deriveRecentSessions } from './activitySections';

const NOW = 200_000_000;
const RECENT = NOW - (48 * 60 * 60 * 1000);
const OLD = NOW - (72 * 60 * 60 * 1000);

const session = (id: string, options: { parentID?: string; archived?: number; updated?: number } = {}): Session => ({
  id,
  parentID: options.parentID,
  time: { created: OLD, updated: options.updated ?? OLD, archived: options.archived },
} as Session);

describe('deriveRecentSessions', () => {
  test('includes an old root session while it is active', () => {
    const oldActive = session('old-active');

    expect(deriveRecentSessions([oldActive], new Set([oldActive.id]), NOW)).toEqual([oldActive]);
  });

  test('does not promote active children or archived sessions into Recent', () => {
    const child = session('child', { parentID: 'parent' });
    const archived = session('archived', { archived: NOW - 1 });

    expect(deriveRecentSessions(
      [child, archived],
      new Set([child.id, archived.id]),
      NOW,
    )).toEqual([]);
  });

  test('backfills below the minimum count with the latest roots outside the window', () => {
    const oldSession = session('old');
    const recentSession = session('recent', { updated: RECENT });

    // Window members come first; old roots backfill up to the minimum count.
    expect(deriveRecentSessions([oldSession, recentSession], new Set(), NOW)).toEqual([recentSession, oldSession]);
  });

  test('does not backfill once the window already meets the minimum count', () => {
    const windowSessions = Array.from({ length: 7 }, (_, index) => session(`w${index}`, { updated: RECENT + index }));
    const oldSession = session('old');

    const result = deriveRecentSessions([...windowSessions, oldSession], new Set(), NOW);

    expect(result).toEqual(windowSessions);
  });

  test('backfill orders old roots by most recent update and respects the cap', () => {
    const older = session('older', { updated: OLD - 1000 });
    const newer = session('newer', { updated: OLD });

    const result = deriveRecentSessions([older, newer], new Set(), NOW);

    expect(result).toEqual([newer, older]);
  });
});
