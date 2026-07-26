import { describe, expect, test } from 'bun:test';

import {
  getShellBridgeAssistantDetails,
  isUserShellMarkerMessage,
  USER_SHELL_MARKER,
} from './shellBridge';
import type { ChatMessageEntry } from './turns/types';

describe('shellBridge tool aliases', () => {
  test('recognizes shell tool aliases for bridge hide/details', () => {
    const message = {
      info: { id: 'msg_a', role: 'assistant', parentID: 'msg_user' },
      parts: [{
        type: 'tool',
        tool: 'shell',
        state: {
          status: 'running',
          input: { command: 'ls' },
          output: 'a',
        },
      }],
    } as unknown as ChatMessageEntry;

    const result = getShellBridgeAssistantDetails(message, 'msg_user');
    expect(result.hide).toBe(true);
    expect(result.details).toEqual({
      command: 'ls',
      output: 'a',
      status: 'running',
    });
  });

  test('detects shell marker user messages', () => {
    const message = {
      info: { id: 'msg_user', role: 'user' },
      parts: [{
        type: 'text',
        synthetic: true,
        text: `${USER_SHELL_MARKER}\nbash`,
      }],
    } as unknown as ChatMessageEntry;

    expect(isUserShellMarkerMessage(message)).toBe(true);
  });
});
