import type { Session } from '@opencode-ai/sdk/v2';

const RECENT_SESSION_MAX_AGE_MS = 48 * 60 * 60 * 1000;

const isSubtaskSession = (session: Session): boolean => {
  return Boolean((session as Session & { parentID?: string | null }).parentID);
};

const isArchivedSession = (session: Session): boolean => {
  return Boolean(session.time?.archived);
};

const getSessionUpdatedAt = (session: Session): number => {
  const updated = session.time?.updated;
  const created = session.time?.created;
  if (typeof updated === 'number' && Number.isFinite(updated)) {
    return updated;
  }
  if (typeof created === 'number' && Number.isFinite(created)) {
    return created;
  }
  return 0;
};

// Quiet periods should not empty the section: when the window yields fewer
// than this many sessions, backfill with the most recently updated roots.
const RECENT_SESSION_MIN_COUNT = 7;

// Recent contains non-archived root sessions that are active now or were
// updated within the retention window, backfilled to a minimum count with the
// latest remaining roots. The caller applies shared lifecycle ordering after
// this membership filter.
export const deriveRecentSessions = (
  sessions: Session[],
  activeSessionIds: ReadonlySet<string>,
  now = Date.now(),
): Session[] => {
  const minUpdatedAt = now - RECENT_SESSION_MAX_AGE_MS;
  const candidates = sessions.filter((session) => !isArchivedSession(session) && !isSubtaskSession(session));
  const inWindow: Session[] = [];
  const outsideWindow: Session[] = [];
  for (const session of candidates) {
    if (activeSessionIds.has(session.id) || getSessionUpdatedAt(session) >= minUpdatedAt) {
      inWindow.push(session);
    } else {
      outsideWindow.push(session);
    }
  }
  if (inWindow.length >= RECENT_SESSION_MIN_COUNT) {
    return inWindow;
  }
  const backfill = outsideWindow
    .sort((a, b) => getSessionUpdatedAt(b) - getSessionUpdatedAt(a))
    .slice(0, RECENT_SESSION_MIN_COUNT - inWindow.length);
  return [...inWindow, ...backfill];
};
