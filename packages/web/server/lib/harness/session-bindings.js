/**
 * In-memory session → harness bindings (v1).
 * Sticky harnessId for the lifetime of an OpenChamber session id.
 */

/** @type {Map<string, object>} */
const bindings = new Map();

/**
 * @param {string} sessionId
 * @returns {object | null}
 */
export function getSessionBinding(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  return bindings.get(sessionId) || null;
}

/**
 * Create or return existing sticky binding. Never mutates harnessId on an
 * existing binding — callers must hand off to a new session instead.
 *
 * @param {object} input
 * @param {string} input.sessionId
 * @param {string} input.harnessId
 * @param {string} input.directory
 * @param {object} input.target
 * @param {object} [input.capabilitySnapshot]
 * @param {string} [input.seedFromSessionId]
 * @param {string} [input.foreignSessionId]
 * @returns {{ binding: object, created: boolean, conflict?: boolean }}
 */
export function bindSession(input) {
  const sessionId = typeof input?.sessionId === 'string' ? input.sessionId : '';
  const harnessId = typeof input?.harnessId === 'string' ? input.harnessId : '';
  const directory = typeof input?.directory === 'string' ? input.directory : '';
  if (!sessionId || !harnessId || !directory) {
    const error = new Error('sessionId, harnessId, and directory are required');
    error.code = 'BINDING_INVALID';
    error.statusCode = 400;
    throw error;
  }

  const existing = bindings.get(sessionId);
  if (existing) {
    if (existing.harnessId !== harnessId) {
      return { binding: existing, created: false, conflict: true };
    }
    const next = {
      ...existing,
      directory,
      target: input.target ?? existing.target,
      updatedAt: Date.now(),
    };
    if (input.capabilitySnapshot) next.capabilitySnapshot = input.capabilitySnapshot;
    if (input.foreignSessionId) next.foreignSessionId = input.foreignSessionId;
    if (input.seedFromSessionId) next.seedFromSessionId = input.seedFromSessionId;
    bindings.set(sessionId, next);
    return { binding: next, created: false, conflict: false };
  }

  const now = Date.now();
  const binding = {
    sessionId,
    harnessId,
    directory,
    target: input.target || { harnessId },
    createdAt: now,
    updatedAt: now,
    capabilitySnapshot: input.capabilitySnapshot || null,
    foreignSessionId: input.foreignSessionId,
    seedFromSessionId: input.seedFromSessionId,
  };
  bindings.set(sessionId, binding);
  return { binding, created: true, conflict: false };
}

/**
 * @param {string} sessionId
 * @param {Partial<object>} patch
 * @returns {object | null}
 */
export function updateSessionBinding(sessionId, patch) {
  const existing = getSessionBinding(sessionId);
  if (!existing) return null;
  const next = {
    ...existing,
    ...patch,
    sessionId: existing.sessionId,
    harnessId: existing.harnessId,
    updatedAt: Date.now(),
  };
  // harnessId is sticky — ignore attempts to rewrite.
  next.harnessId = existing.harnessId;
  bindings.set(sessionId, next);
  return next;
}

/**
 * @param {string} sessionId
 * @param {string} foreignSessionId
 * @returns {object | null}
 */
export function setForeignSessionId(sessionId, foreignSessionId) {
  if (typeof foreignSessionId !== 'string' || !foreignSessionId) return getSessionBinding(sessionId);
  return updateSessionBinding(sessionId, { foreignSessionId });
}

/**
 * @param {string} sessionId
 * @param {{ code: string, message: string }} error
 * @returns {object | null}
 */
export function setBindingError(sessionId, error) {
  return updateSessionBinding(sessionId, {
    lastError: {
      code: error.code || 'HARNESS_ERROR',
      message: error.message || 'Harness error',
      at: Date.now(),
    },
  });
}

/**
 * @param {string} sessionId
 * @returns {boolean}
 */
export function clearSessionBinding(sessionId) {
  return bindings.delete(sessionId);
}

/** Test helper — clears all bindings. */
export function resetSessionBindings() {
  bindings.clear();
}

/**
 * @returns {object[]}
 */
export function listSessionBindings() {
  return Array.from(bindings.values());
}
