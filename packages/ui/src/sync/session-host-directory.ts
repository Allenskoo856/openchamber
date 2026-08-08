import { normalizePath } from '@/lib/pathNormalization';

/**
 * Which host project directory a workspace-routed session belongs to.
 *
 * The session's own record cannot say: OpenCode reports `directory=/workspace`,
 * `projectID=global`, and no `workspaceID` on any read path, and directory-scoped
 * session lists exclude routed sessions entirely, so neither the resolver nor child
 * store membership can attribute them. This map is written from the two places that do
 * know — the creating client at creation time, and the server-recorded session routes
 * fetched at startup — and read by sidebar ownership as its fallback.
 */
const hostDirectoryBySessionId = new Map<string, string>();

export const rememberSessionHostDirectory = (sessionId: string, directory: string | null | undefined): void => {
  const normalized = normalizePath(directory ?? null);
  if (!sessionId || !normalized) return;
  hostDirectoryBySessionId.set(sessionId, normalized);
};

export const getSessionHostDirectory = (sessionId: string): string | null => (
  hostDirectoryBySessionId.get(sessionId) ?? null
);

/** Merges server-recorded routes in; returns whether anything new was learned. */
export const hydrateSessionHostDirectories = (
  routes: Array<{ sessionID: string; projectDirectory: string }>,
): boolean => {
  let changed = false;
  for (const route of routes) {
    const normalized = normalizePath(route.projectDirectory);
    if (!route.sessionID || !normalized) continue;
    if (hostDirectoryBySessionId.get(route.sessionID) === normalized) continue;
    hostDirectoryBySessionId.set(route.sessionID, normalized);
    changed = true;
  }
  return changed;
};
