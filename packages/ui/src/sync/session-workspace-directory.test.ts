import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { resolveSessionDirectoryKey } from './session-directory';

/** Only the fields the resolver reads; the rest of a Session is irrelevant here. */
const sessionLike = (fields: Record<string, unknown>) => fields as unknown as Session;

/**
 * A session running in a secure workspace reports the directory it works in, which is
 * inside the container. Host-side state must never take that as a path on this computer:
 * the file tree points at a directory that does not exist here, and the value is
 * persisted as `lastDirectory`, so it outlives the session that introduced it.
 */
describe('directory of a session routed into a workspace', () => {
  test('uses the project worktree rather than the path inside the container', () => {
    const session = sessionLike({
      id: 's1',
      workspaceID: 'wrk_1',
      directory: '/workspace',
      project: { worktree: 'C:/Users/me/project' },
    });

    expect(resolveSessionDirectoryKey(session)).toBe('C:/Users/me/project');
  });

  test('reports no directory rather than a container path when the host one is unknown', () => {
    const session = sessionLike({ id: 's1', workspaceID: 'wrk_1', directory: '/workspace', project: null });

    expect(resolveSessionDirectoryKey(session)).toBeNull();
  });

  test('keeps using the session directory for work that runs on this computer', () => {
    const session = sessionLike({ id: 's1', directory: 'C:/Users/me/project', project: { worktree: 'C:/Users/me/other' } });

    expect(resolveSessionDirectoryKey(session)).toBe('C:/Users/me/project');
  });
});
