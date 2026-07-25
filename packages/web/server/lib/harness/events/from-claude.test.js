import { describe, expect, it } from 'bun:test';
import {
  buildUserMessageEvents,
  createClaudeMapperContext,
  mapClaudeMessageToEvents,
} from './from-claude.js';

describe('from-claude mapper', () => {
  it('emits user message.updated + text part + busy status', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/project',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
      modelRef: 'sonnet',
    });
    const events = buildUserMessageEvents(ctx, 'hello');
    expect(events.map((e) => e.type)).toEqual([
      'message.updated',
      'message.part.updated',
      'session.status',
    ]);
    expect(events[0].properties.info.role).toBe('user');
    expect(events[1].properties.part.text).toBe('hello');
    expect(events[2].properties.status.type).toBe('busy');
  });

  it('maps stream text deltas to message.part.delta', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/project',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
      textPartId: 'prt_text',
    });

    const first = mapClaudeMessageToEvents(ctx, {
      type: 'stream_event',
      session_id: 'foreign_1',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hi' },
      },
    });

    expect(first.foreignSessionId).toBe('foreign_1');
    expect(first.events.some((e) => e.type === 'message.part.delta')).toBe(true);
    const delta = first.events.find((e) => e.type === 'message.part.delta');
    expect(delta.properties).toMatchObject({
      messageID: 'msg_assistant',
      partID: 'prt_text',
      field: 'text',
      delta: 'Hi',
    });
  });

  it('maps tool_use and tool_result to tool parts', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/project',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
    });

    const toolStart = mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      session_id: 'foreign_1',
      message: {
        content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a.ts' } }],
      },
    });
    expect(toolStart.events.some((e) => e.type === 'message.part.updated')).toBe(true);
    const toolPart = toolStart.events.find((e) => e.properties?.part?.type === 'tool');
    expect(toolPart.properties.part.tool).toBe('Read');
    expect(toolPart.properties.part.state.status).toBe('running');

    const toolEnd = mapClaudeMessageToEvents(ctx, {
      type: 'user',
      session_id: 'foreign_1',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }],
      },
    });
    const completed = toolEnd.events.find((e) => e.properties?.part?.type === 'tool');
    expect(completed.properties.part.state.status).toBe('completed');
  });

  it('maps result to idle status and finalizes assistant message', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/project',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
      textPartId: 'prt_text',
      accumulatedText: 'done',
    });

    const mapped = mapClaudeMessageToEvents(ctx, {
      type: 'result',
      subtype: 'success',
      session_id: 'foreign_1',
      result: 'done',
      is_error: false,
    });

    expect(mapped.events.some((e) => e.type === 'session.status' && e.properties.status.type === 'idle')).toBe(true);
    expect(mapped.events.some((e) => e.type === 'message.updated' && e.properties.info.finish === 'stop')).toBe(true);
  });

  it('ignores unknown message types without throwing', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/project',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
    });
    expect(mapClaudeMessageToEvents(ctx, { type: 'totally_unknown' }).events).toEqual([]);
    expect(mapClaudeMessageToEvents(ctx, null).events).toEqual([]);
  });
});
