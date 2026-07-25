/**
 * Claude Code translator — prompt/abort orchestration.
 */

import { mapAttachmentsToContentBlocks } from './attachments.js';
import { startClaudeQuery } from './query.js';
import {
  buildUserMessageEvents,
  createClaudeMapperContext,
  createOpenCodeId,
  mapClaudeMessageToEvents,
} from '../../events/from-claude.js';
import { emitHarnessEvents } from '../../events/emit.js';
import {
  bindSession,
  getSessionBinding,
  setBindingError,
  setForeignSessionId,
  updateSessionBinding,
} from '../../session-bindings.js';
import { getHarnessCapabilities } from '../../registry.js';
import { detectClaudeCode } from '../../detect.js';

/**
 * Build SDK prompt: string when text-only; AsyncIterable when attachments present.
 * @param {string} text
 * @param {unknown[]} files
 * @returns {string | AsyncIterable<object>}
 */
export function buildClaudePrompt(text, files) {
  const blocks = mapAttachmentsToContentBlocks(files);
  if (blocks.length === 0) {
    return typeof text === 'string' ? text : '';
  }
  const content = [
    { type: 'text', text: typeof text === 'string' ? text : '' },
    ...blocks,
  ];
  return (async function* streamUserMessage() {
    yield {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content,
      },
    };
  })();
}

/**
 * @param {object} deps
 * @param {() => ((payload: object, options?: object) => void) | null | undefined} [deps.getBroadcast]
 * @param {typeof startClaudeQuery} [deps.startQuery]
 * @param {typeof detectClaudeCode} [deps.detect]
 */
export function createClaudeCodeTranslator(deps = {}) {
  /** @type {Map<string, { handle: object, aborting: boolean }>} */
  const activeTurns = new Map();
  const getBroadcast = deps.getBroadcast || (() => null);
  const startQuery = deps.startQuery || startClaudeQuery;
  const detect = deps.detect || detectClaudeCode;

  /**
   * @param {object} body
   */
  const prompt = async (body) => {
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    const directory = typeof body?.directory === 'string' ? body.directory : '';
    const text = typeof body?.text === 'string' ? body.text : '';
    const target = body?.target && typeof body.target === 'object' ? body.target : null;
    const harnessId = target?.harnessId || 'claude-code';

    if (!sessionId || !directory) {
      const error = new Error('sessionId and directory are required');
      error.code = 'PROMPT_INVALID';
      error.statusCode = 400;
      throw error;
    }
    if (harnessId !== 'claude-code') {
      const error = new Error(`Unsupported harnessId for Claude translator: ${harnessId}`);
      error.code = 'HARNESS_UNSUPPORTED';
      error.statusCode = 400;
      throw error;
    }

    const detection = await detect();
    if (detection.status !== 'ready') {
      const error = new Error(detection.statusDetail || `Claude Code is not ready (${detection.status})`);
      error.code = detection.status === 'missing-cli'
        ? 'CLAUDE_MISSING_CLI'
        : detection.status === 'needs-login'
          ? 'CLAUDE_NEEDS_LOGIN'
          : 'CLAUDE_NOT_READY';
      error.statusCode = 503;
      error.status = detection.status;
      throw error;
    }

    const existing = getSessionBinding(sessionId);
    if (existing && existing.harnessId !== 'claude-code') {
      const error = new Error('Session is bound to a different engine; create a new session for handoff');
      error.code = 'BINDING_CONFLICT';
      error.statusCode = 409;
      throw error;
    }

    if (activeTurns.has(sessionId)) {
      const error = new Error('A Claude Code turn is already active for this session');
      error.code = 'TURN_IN_PROGRESS';
      error.statusCode = 409;
      throw error;
    }

    const capabilities = getHarnessCapabilities('claude-code');
    const { binding } = bindSession({
      sessionId,
      harnessId: 'claude-code',
      directory,
      target: {
        harnessId: 'claude-code',
        modelRef: typeof target?.modelRef === 'string' ? target.modelRef : 'sonnet',
        permissionMode: target?.permissionMode,
      },
      capabilitySnapshot: capabilities,
      seedFromSessionId: typeof body?.seedFromSessionId === 'string' ? body.seedFromSessionId : undefined,
    });

    const userMessageId = typeof body?.messageId === 'string' && body.messageId
      ? body.messageId
      : createOpenCodeId('msg');
    const assistantMessageId = typeof body?.assistantMessageId === 'string' && body.assistantMessageId
      ? body.assistantMessageId
      : createOpenCodeId('msg');

    const ctx = createClaudeMapperContext({
      sessionId,
      directory,
      userMessageId,
      assistantMessageId,
      modelRef: binding.target?.modelRef || 'sonnet',
    });

    const broadcast = getBroadcast();
    const userEvents = buildUserMessageEvents(ctx, text);
    emitHarnessEvents(broadcast, directory, userEvents);

    let promptInput;
    try {
      promptInput = buildClaudePrompt(text, body?.files);
    } catch (error) {
      setBindingError(sessionId, {
        code: error.code || 'ATTACHMENT_ERROR',
        message: error.message || 'Attachment mapping failed',
      });
      emitHarnessEvents(broadcast, directory, [{
        type: 'session.status',
        properties: { sessionID: sessionId, status: { type: 'idle' } },
      }]);
      throw error;
    }

    let handle;
    try {
      handle = await startQuery({
        prompt: promptInput,
        cwd: directory,
        model: binding.target?.modelRef,
        resume: binding.foreignSessionId,
        permissionMode: binding.target?.permissionMode,
        includePartialMessages: true,
      });
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      if (!wrapped.code) wrapped.code = 'CLAUDE_SDK_UNAVAILABLE';
      if (!wrapped.statusCode) wrapped.statusCode = 503;
      setBindingError(sessionId, { code: wrapped.code, message: wrapped.message });
      emitHarnessEvents(broadcast, directory, [{
        type: 'session.status',
        properties: { sessionID: sessionId, status: { type: 'idle' } },
      }]);
      throw wrapped;
    }

    activeTurns.set(sessionId, { handle, aborting: false });

    // Stream in background; HTTP returns accepted immediately.
    void (async () => {
      try {
        for await (const message of handle.stream) {
          const { events, foreignSessionId } = mapClaudeMessageToEvents(ctx, message);
          if (foreignSessionId) {
            setForeignSessionId(sessionId, foreignSessionId);
          }
          emitHarnessEvents(getBroadcast(), directory, events);
        }
        updateSessionBinding(sessionId, { lastError: undefined });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Claude Code turn failed';
        setBindingError(sessionId, { code: 'CLAUDE_TURN_ERROR', message });
        emitHarnessEvents(getBroadcast(), directory, [
          {
            type: 'session.status',
            properties: { sessionID: sessionId, status: { type: 'idle' } },
          },
          {
            type: 'session.error',
            properties: { sessionID: sessionId },
          },
        ]);
      } finally {
        try {
          handle.close();
        } catch {
          // ignore
        }
        activeTurns.delete(sessionId);
      }
    })();

    return {
      ok: true,
      sessionId,
      harnessId: 'claude-code',
      messageId: userMessageId,
      assistantMessageId,
      foreignSessionId: getSessionBinding(sessionId)?.foreignSessionId,
      status: 'started',
    };
  };

  /**
   * @param {{ sessionId: string }} body
   */
  const abort = async (body) => {
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    if (!sessionId) {
      const error = new Error('sessionId is required');
      error.code = 'ABORT_INVALID';
      error.statusCode = 400;
      throw error;
    }

    const active = activeTurns.get(sessionId);
    const binding = getSessionBinding(sessionId);
    if (!active) {
      return { ok: true, sessionId, aborted: false, reason: 'no-active-turn' };
    }

    active.aborting = true;
    try {
      await active.handle.interrupt();
    } catch {
      // ignore
    }
    try {
      active.handle.close();
    } catch {
      // ignore
    }
    activeTurns.delete(sessionId);

    if (binding?.directory) {
      emitHarnessEvents(getBroadcast(), binding.directory, [{
        type: 'session.status',
        properties: { sessionID: sessionId, status: { type: 'idle' } },
      }]);
    }

    return { ok: true, sessionId, aborted: true };
  };

  return {
    prompt,
    abort,
    /** @internal test helper */
    _activeTurns: activeTurns,
  };
}

export const claudeCodeTranslator = createClaudeCodeTranslator();
