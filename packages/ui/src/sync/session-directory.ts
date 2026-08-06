import type { Session } from '@opencode-ai/sdk/v2';
import { normalizePath } from '@/lib/pathNormalization';

type SessionDirectoryFields = Session & {
  directory?: string | null;
  project?: { worktree?: string | null } | null;
  workspaceID?: string | null;
};

/**
 * The directory on this computer that a session belongs to, or null when there is none.
 *
 * A session routed into a secure workspace reports the directory it works in, and that
 * directory is inside the container — `/workspace`, not a path here. Host-side state must
 * not take it: the file tree would point at a directory that does not exist, and the value
 * is persisted as `lastDirectory`, so it outlives the session that introduced it. Paths
 * are converted at the transport boundary, and this is that boundary.
 */
export function resolveSessionDirectoryKey(session: Session): string | null {
  const record = session as SessionDirectoryFields;
  if (typeof record.workspaceID === 'string' && record.workspaceID) {
    return normalizePath(record.project?.worktree ?? null);
  }
  return normalizePath(record.directory ?? null) ?? normalizePath(record.project?.worktree ?? null);
}
