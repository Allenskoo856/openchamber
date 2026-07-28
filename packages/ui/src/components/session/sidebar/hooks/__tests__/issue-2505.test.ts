/**
 * Reproduction for issue #2505: Archived sessions section broken, lost all sessions.
 *
 * Root cause: `getGroupKey` in `useSessionGrouping.ts` incorrectly routes
 * non-archived active sessions to the archived bucket when their directory
 * doesn't match the project root or any registered worktree (line 139).
 *
 * When the user then clicks "delete all archived" in the sidebar, these
 * incorrectly-classified non-archived sessions are included in the deletion,
 * causing permanent data loss.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { WorktreeMetadata } from '@/types/worktree';
import { normalizePath } from '@/lib/pathNormalization';
import {
  resolveGlobalSessionDirectory,
  useGlobalSessionsStore,
} from '@/stores/useGlobalSessionsStore';

/**
 * Simulates the `getGroupKey` logic from `useSessionGrouping.ts` lines 127-140.
 *
 * We extract the logic here so we can test it in isolation without needing
 * the full React component tree.
 */
function simulateGetGroupKey(
  session: Session,
  normalizedProjectRoot: string | null,
  worktreeByPath: Map<string, WorktreeMetadata>,
  worktreeMetadata: Map<string, { path: string }>,
  isVSCode: boolean,
): string {
  // Line 128: explicitly archived sessions correctly go to archivedKey
  if (session.time?.archived) return '__archived__';

  if (isVSCode) return normalizedProjectRoot ?? '__project_root__';

  const metadataPath = normalizePath(worktreeMetadata.get(session.id)?.path ?? null);
  // Lines 134-135: find the normalized directory
  const normalizedDir = metadataPath ?? resolveGlobalSessionDirectory(session);

  // LINE 136 — BUG: non-archived sessions with no directory get routed to archived bucket
  if (!normalizedDir) return '__archived__';

  // Line 137: sessions in recognized worktrees go to worktree groups
  if (normalizedDir !== normalizedProjectRoot && worktreeByPath.has(normalizedDir)) return normalizedDir;

  // Line 138: sessions in project root go to main group
  if (normalizedDir === normalizedProjectRoot) return normalizedProjectRoot ?? '__project_root__';

  // LINE 139 — BUG: non-archived sessions whose directory is neither the project
  // root nor a registered worktree get routed to the archived bucket.
  // This is incorrect — they are NOT archived, just unassociated with a known
  // worktree or project root.
  return '__archived__';
}

type SessionExtra = Partial<Session> & {
  directory?: string | null;
  project?: { worktree?: string | null } | null;
};

const buildSession = (id: string, extra: SessionExtra = {}): Session => ({
  id,
  title: `Session ${id}`,
  time: { created: 1, updated: 2 },
  ...extra,
} as Session);

describe('Issue #2505 — archived section misclassifies non-archived sessions', () => {
  beforeEach(() => {
    useGlobalSessionsStore.setState({
      activeSessions: [],
      archivedSessions: [],
      sessionsByDirectory: new Map(),
      hasLoaded: false,
      status: 'idle',
    });
  });

  test('BUG: non-archived session with orphaned worktree directory goes to archived bucket', () => {
    const projectRoot = '/Users/user/project';
    const worktreePath = '/Users/user/project-worktree';

    // An active (non-archived) session that used to live in a worktree
    // that is no longer registered — e.g. the worktree was deleted.
    const orphanSession = buildSession('ses_orphan', {
      directory: worktreePath,
      time: { created: 100, updated: 200 },
    });

    // Current registered worktrees — the orphan worktree is NOT in this set
    const worktreeByPath = new Map<string, WorktreeMetadata>();
    // worktreeByPath does NOT have worktreePath — it was removed

    // No worktree metadata for this session
    const worktreeMetadata = new Map<string, { path: string }>();

    const groupKey = simulateGetGroupKey(
      orphanSession,
      projectRoot,
      worktreeByPath,
      worktreeMetadata,
      false,
    );

    // BUG: This non-archived session gets routed to the archived bucket
    expect(groupKey).toBe('__archived__');

    // EXPECTED behavior: should go to a fallback or main group
    // Since the directory doesn't match any known worktree or project root,
    // it should ideally go to an "unassociated" group or stay in the main
    // active area. But instead it's incorrectly classified as "archived",
    // which means the "delete all archived" button will include it.
  });

  test('BUG: non-archived session without directory field goes to archived bucket', () => {
    const projectRoot = '/Users/user/project';

    // An active session that has no directory metadata
    const noDirSession = buildSession('ses_no_dir', {
      // No directory, no project.worktree
      time: { created: 100, updated: 200 },
    });

    const worktreeByPath = new Map<string, WorktreeMetadata>();
    const worktreeMetadata = new Map<string, { path: string }>();

    const groupKey = simulateGetGroupKey(
      noDirSession,
      projectRoot,
      worktreeByPath,
      worktreeMetadata,
      false,
    );

    // BUG: Non-archived session without directory gets routed to archived bucket
    expect(groupKey).toBe('__archived__');

    // This is problematic because:
    // 1. Session appears in the archived bucket in the sidebar (among truly archived sessions)
    // 2. When user clicks "Delete all archived" or deletes individual sessions from
    //    the archived group, this non-archived session gets permanently deleted
    // 3. The user loses a session they never intended to delete
  });

  test('truly archived session correctly goes to archived bucket (no regression)', () => {
    const projectRoot = '/Users/user/project';

    // A truly archived session — user explicitly archived it
    const archivedSession = buildSession('ses_archived', {
      directory: '/Users/user/project',
      time: { created: 100, updated: 200, archived: 300 },
    });

    const worktreeByPath = new Map<string, WorktreeMetadata>();
    const worktreeMetadata = new Map<string, { path: string }>();

    const groupKey = simulateGetGroupKey(
      archivedSession,
      projectRoot,
      worktreeByPath,
      worktreeMetadata,
      false,
    );

    // Correct: truly archived sessions go to the archived bucket
    expect(groupKey).toBe('__archived__');
  });

  test('active session in project root correctly goes to main group', () => {
    const projectRoot = '/Users/user/project';

    const activeSession = buildSession('ses_active', {
      directory: projectRoot,
      time: { created: 100, updated: 200 },
    });

    const worktreeByPath = new Map<string, WorktreeMetadata>();
    const worktreeMetadata = new Map<string, { path: string }>();

    const groupKey = simulateGetGroupKey(
      activeSession,
      projectRoot,
      worktreeByPath,
      worktreeMetadata,
      false,
    );

    // Correct: active sessions in the project root go to the main group
    expect(groupKey).toBe(projectRoot);
  });

  test('active session in recognized worktree correctly goes to worktree group', () => {
    const projectRoot = '/Users/user/project';
    const worktreePath = '/Users/user/project-feature';

    const activeSession = buildSession('ses_worktree', {
      directory: worktreePath,
      time: { created: 100, updated: 200 },
    });

    const worktreeByPath = new Map<string, WorktreeMetadata>([
      [worktreePath, { path: worktreePath, label: 'feature', projectDirectory: projectRoot, branch: 'feature' }],
    ]);
    const worktreeMetadata = new Map<string, { path: string }>();

    const groupKey = simulateGetGroupKey(
      activeSession,
      projectRoot,
      worktreeByPath,
      worktreeMetadata,
      false,
    );

    // Correct: sessions in known worktrees go to the worktree's own group
    expect(groupKey).toBe(worktreePath);
  });

  test('show impact: delete all archived would delete non-archived sessions', () => {
    // Simulate what happens in SessionGroupSection when "delete all archived" is clicked.
    // The "allGroupSessions" includes all sessions in the archived bucket.
    // If non-archived sessions are incorrectly there, they'd be deleted.

    const projectRoot = '/Users/user/project';
    const worktreePath = '/Users/user/project-worktree';

    // Truly archived session
    const trulyArchived = buildSession('ses_truly_archived', {
      directory: projectRoot,
      time: { created: 100, updated: 200, archived: 300 },
    });

    // Non-archived session incorrectly routed to archived bucket
    // (because its directory is no longer a recognized worktree)
    const incorrectlyRouted = buildSession('ses_incorrectly_routed', {
      directory: worktreePath, // worktree was removed
      time: { created: 100, updated: 200 }, // NOT archived
    });

    // Both sessions end up in the archived bucket via simulateGetGroupKey
    const worktreeByPath = new Map<string, WorktreeMetadata>();
    const worktreeMetadata = new Map<string, { path: string }>();

    const key1 = simulateGetGroupKey(trulyArchived, projectRoot, worktreeByPath, worktreeMetadata, false);
    const key2 = simulateGetGroupKey(incorrectlyRouted, projectRoot, worktreeByPath, worktreeMetadata, false);

    expect(key1).toBe('__archived__'); // correct
    expect(key2).toBe('__archived__'); // BUG: should NOT be archived

    // Simulate "delete all archived": collect all sessions in the archived bucket
    const allArchivedGroupSessions = [trulyArchived, incorrectlyRouted];

    // The session IDs that would be passed to deleteSessions()
    const idsToDelete = allArchivedGroupSessions.map((s) => s.id);
    expect(idsToDelete).toContain('ses_incorrectly_routed');
    // ^^ This non-archived session would be PERMANENTLY DELETED by the
    // "delete all archived" action, causing data loss.
  });
});
