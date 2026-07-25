/**
 * Map Claude Agent SDK messages → OpenCode-shaped canonical events.
 * Unknown event types are ignored safely (no throw).
 */

import crypto from 'node:crypto';

/**
 * @param {string} prefix
 * @returns {string}
 */
export function createOpenCodeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * @typedef {object} ClaudeMapperContext
 * @property {string} sessionId
 * @property {string} directory
 * @property {string} userMessageId
 * @property {string} assistantMessageId
 * @property {string} [modelRef]
 * @property {string} [textPartId]
 * @property {Map<string, string>} [toolPartIds]
 * @property {string} [foreignSessionId]
 * @property {number} [assistantCreatedAt]
 * @property {string} [accumulatedText]
 */

/**
 * @param {Partial<ClaudeMapperContext>} input
 * @returns {ClaudeMapperContext}
 */
export function createClaudeMapperContext(input) {
  return {
    sessionId: input.sessionId,
    directory: input.directory,
    userMessageId: input.userMessageId || createOpenCodeId('msg'),
    assistantMessageId: input.assistantMessageId || createOpenCodeId('msg'),
    modelRef: input.modelRef || 'sonnet',
    textPartId: input.textPartId || createOpenCodeId('prt'),
    toolPartIds: input.toolPartIds || new Map(),
    foreignSessionId: input.foreignSessionId,
    assistantCreatedAt: input.assistantCreatedAt || Date.now(),
    accumulatedText: input.accumulatedText || '',
  };
}

/**
 * @param {ClaudeMapperContext} ctx
 * @param {string} text
 * @returns {object[]}
 */
export function buildUserMessageEvents(ctx, text) {
  const now = Date.now();
  const partId = createOpenCodeId('prt');
  return [
    {
      type: 'message.updated',
      properties: {
        info: {
          id: ctx.userMessageId,
          sessionID: ctx.sessionId,
          role: 'user',
          time: { created: now },
          agent: 'build',
          model: {
            providerID: 'claude-code',
            modelID: ctx.modelRef || 'sonnet',
          },
        },
      },
    },
    {
      type: 'message.part.updated',
      properties: {
        sessionID: ctx.sessionId,
        part: {
          id: partId,
          sessionID: ctx.sessionId,
          messageID: ctx.userMessageId,
          type: 'text',
          text: typeof text === 'string' ? text : '',
          time: { start: now, end: now },
        },
      },
    },
    {
      type: 'session.status',
      properties: {
        sessionID: ctx.sessionId,
        status: { type: 'busy' },
      },
    },
  ];
}

/**
 * @param {ClaudeMapperContext} ctx
 * @returns {object}
 */
function assistantInfo(ctx, completed) {
  const info = {
    id: ctx.assistantMessageId,
    sessionID: ctx.sessionId,
    role: 'assistant',
    time: {
      created: ctx.assistantCreatedAt,
      ...(completed ? { completed: Date.now() } : {}),
    },
    parentID: ctx.userMessageId,
    modelID: ctx.modelRef || 'sonnet',
    providerID: 'claude-code',
    mode: 'build',
    agent: 'build',
    path: {
      cwd: ctx.directory,
      root: ctx.directory,
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
  if (completed) info.finish = 'stop';
  return info;
}

/**
 * @param {ClaudeMapperContext} ctx
 * @param {string} delta
 * @returns {object[]}
 */
function textDeltaEvents(ctx, delta) {
  if (typeof delta !== 'string' || !delta) return [];
  const events = [];
  if (!ctx.accumulatedText) {
    events.push({
      type: 'message.updated',
      properties: { info: assistantInfo(ctx, false) },
    });
    events.push({
      type: 'message.part.updated',
      properties: {
        sessionID: ctx.sessionId,
        part: {
          id: ctx.textPartId,
          sessionID: ctx.sessionId,
          messageID: ctx.assistantMessageId,
          type: 'text',
          text: '',
          time: { start: Date.now() },
        },
      },
    });
  }
  ctx.accumulatedText = (ctx.accumulatedText || '') + delta;
  events.push({
    type: 'message.part.delta',
    properties: {
      sessionID: ctx.sessionId,
      messageID: ctx.assistantMessageId,
      partID: ctx.textPartId,
      field: 'text',
      delta,
    },
  });
  return events;
}

/**
 * @param {ClaudeMapperContext} ctx
 * @param {object} block
 * @returns {object[]}
 */
function mapContentBlock(ctx, block) {
  if (!block || typeof block !== 'object') return [];
  if (block.type === 'text' && typeof block.text === 'string') {
    // Prefer deltas for streaming; full text block fills when no partials arrived.
    if (!ctx.accumulatedText) {
      return textDeltaEvents(ctx, block.text);
    }
    const remainder = block.text.startsWith(ctx.accumulatedText)
      ? block.text.slice(ctx.accumulatedText.length)
      : '';
    if (remainder) return textDeltaEvents(ctx, remainder);
    return [];
  }

  if (block.type === 'tool_use') {
    const callId = typeof block.id === 'string' ? block.id : createOpenCodeId('call');
    let partId = ctx.toolPartIds.get(callId);
    if (!partId) {
      partId = createOpenCodeId('prt');
      ctx.toolPartIds.set(callId, partId);
    }
    const toolName = typeof block.name === 'string' ? block.name : 'tool';
    const input = block.input && typeof block.input === 'object' ? block.input : {};
    return [
      {
        type: 'message.updated',
        properties: { info: assistantInfo(ctx, false) },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: ctx.sessionId,
          part: {
            id: partId,
            sessionID: ctx.sessionId,
            messageID: ctx.assistantMessageId,
            type: 'tool',
            callID: callId,
            tool: toolName,
            state: {
              status: 'running',
              input,
              time: { start: Date.now() },
            },
          },
        },
      },
    ];
  }

  return [];
}

/**
 * @param {ClaudeMapperContext} ctx
 * @param {object} block
 * @returns {object[]}
 */
function mapToolResultBlock(ctx, block) {
  if (!block || block.type !== 'tool_result') return [];
  const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
  if (!callId) return [];
  let partId = ctx.toolPartIds.get(callId);
  if (!partId) {
    partId = createOpenCodeId('prt');
    ctx.toolPartIds.set(callId, partId);
  }
  const output = typeof block.content === 'string'
    ? block.content
    : Array.isArray(block.content)
      ? block.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
      : '';
  const isError = block.is_error === true;
  return [
    {
      type: 'message.part.updated',
      properties: {
        sessionID: ctx.sessionId,
        part: {
          id: partId,
          sessionID: ctx.sessionId,
          messageID: ctx.assistantMessageId,
          type: 'tool',
          callID: callId,
          tool: 'tool',
          state: isError
            ? {
              status: 'error',
              input: {},
              error: output || 'Tool error',
              time: { start: Date.now(), end: Date.now() },
            }
            : {
              status: 'completed',
              input: {},
              output: output || '',
              title: 'tool',
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            },
        },
      },
    },
  ];
}

/**
 * Map one SDK message into zero or more canonical events.
 * Mutates ctx for streaming state (accumulated text, foreign id, tool ids).
 *
 * @param {ClaudeMapperContext} ctx
 * @param {object} message
 * @returns {{ events: object[], foreignSessionId?: string }}
 */
export function mapClaudeMessageToEvents(ctx, message) {
  if (!message || typeof message !== 'object') {
    return { events: [] };
  }

  const events = [];
  let foreignSessionId;

  if (typeof message.session_id === 'string' && message.session_id) {
    foreignSessionId = message.session_id;
    ctx.foreignSessionId = foreignSessionId;
  }

  switch (message.type) {
    case 'system': {
      if (message.subtype === 'init' && typeof message.session_id === 'string') {
        foreignSessionId = message.session_id;
        ctx.foreignSessionId = foreignSessionId;
      }
      break;
    }

    case 'stream_event': {
      const event = message.event;
      if (!event || typeof event !== 'object') break;
      if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          events.push(...textDeltaEvents(ctx, delta.text));
        }
      } else if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block?.type === 'tool_use') {
          events.push(...mapContentBlock(ctx, block));
        } else if (block?.type === 'text' && !ctx.accumulatedText) {
          events.push({
            type: 'message.updated',
            properties: { info: assistantInfo(ctx, false) },
          });
          events.push({
            type: 'message.part.updated',
            properties: {
              sessionID: ctx.sessionId,
              part: {
                id: ctx.textPartId,
                sessionID: ctx.sessionId,
                messageID: ctx.assistantMessageId,
                type: 'text',
                text: '',
                time: { start: Date.now() },
              },
            },
          });
        }
      }
      break;
    }

    case 'assistant': {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          events.push(...mapContentBlock(ctx, block));
        }
      }
      if (message.error) {
        events.push({
          type: 'session.status',
          properties: {
            sessionID: ctx.sessionId,
            status: { type: 'idle' },
          },
        });
        events.push({
          type: 'message.updated',
          properties: {
            info: {
              ...assistantInfo(ctx, true),
              error: {
                name: 'APIError',
                data: {
                  message: String(message.error),
                  isRetryable: message.error === 'rate_limit' || message.error === 'overloaded',
                },
              },
            },
          },
        });
      }
      break;
    }

    case 'user': {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          events.push(...mapToolResultBlock(ctx, block));
        }
      }
      break;
    }

    case 'result': {
      if (ctx.accumulatedText || ctx.toolPartIds.size > 0) {
        events.push({
          type: 'message.part.updated',
          properties: {
            sessionID: ctx.sessionId,
            part: {
              id: ctx.textPartId,
              sessionID: ctx.sessionId,
              messageID: ctx.assistantMessageId,
              type: 'text',
              text: ctx.accumulatedText || '',
              time: { start: ctx.assistantCreatedAt, end: Date.now() },
            },
          },
        });
        events.push({
          type: 'message.updated',
          properties: { info: assistantInfo(ctx, true) },
        });
      } else if (typeof message.result === 'string' && message.result) {
        events.push(...textDeltaEvents(ctx, message.result));
        events.push({
          type: 'message.updated',
          properties: { info: assistantInfo(ctx, true) },
        });
      }

      const isError = message.is_error === true || (typeof message.subtype === 'string' && message.subtype.startsWith('error_'));
      events.push({
        type: 'session.status',
        properties: {
          sessionID: ctx.sessionId,
          status: { type: 'idle' },
        },
      });
      if (isError) {
        events.push({
          type: 'session.error',
          properties: {
            sessionID: ctx.sessionId,
          },
        });
      }
      break;
    }

    default:
      // Ignore unknown types safely.
      break;
  }

  return { events, foreignSessionId };
}
