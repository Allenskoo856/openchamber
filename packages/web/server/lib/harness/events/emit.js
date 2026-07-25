/**
 * Emit OpenCode-shaped events through the injected global UI broadcaster.
 * Directory scoping keeps transcript events on the correct project stream.
 */

/**
 * @param {(payload: object, options?: { directory?: string, eventId?: string }) => void} broadcast
 * @param {object} payload
 * @param {{ directory?: string, eventId?: string }} [options]
 */
export function emitHarnessEvent(broadcast, payload, options = {}) {
  if (typeof broadcast !== 'function' || !payload || typeof payload !== 'object') {
    return;
  }
  const directory = typeof options.directory === 'string' && options.directory.length > 0
    ? options.directory
    : undefined;
  const eventId = typeof options.eventId === 'string' && options.eventId.length > 0
    ? options.eventId
    : undefined;
  broadcast(payload, {
    ...(directory ? { directory } : {}),
    ...(eventId ? { eventId } : {}),
  });
}

/**
 * @param {(payload: object, options?: object) => void} broadcast
 * @param {string} directory
 * @param {object[]} events
 */
export function emitHarnessEvents(broadcast, directory, events) {
  if (!Array.isArray(events)) return;
  for (const event of events) {
    emitHarnessEvent(broadcast, event, { directory });
  }
}
