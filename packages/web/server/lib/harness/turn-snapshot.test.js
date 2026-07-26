import { describe, expect, it, beforeEach } from 'vitest';
import {
  applyHarnessEventToSnapshot,
  getHarnessRecentMessages,
  getHarnessTurnSnapshot,
  isHarnessSessionWorking,
  resetHarnessTurnSnapshots,
} from './turn-snapshot.js';

describe('harness turn snapshot', () => {
  beforeEach(() => {
    resetHarnessTurnSnapshots();
  });

  it('tracks busy/idle and assistant text for goal ticks', () => {
    applyHarnessEventToSnapshot({
      type: 'session.status',
      properties: { sessionID: 'ses_a', status: { type: 'busy' } },
    }, '/proj');
    expect(isHarnessSessionWorking('ses_a')).toBe(true);

    applyHarnessEventToSnapshot({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_u',
          sessionID: 'ses_a',
          role: 'user',
          time: { created: 1 },
        },
      },
    }, '/proj');
    applyHarnessEventToSnapshot({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_t',
          sessionID: 'ses_a',
          messageID: 'msg_a',
          type: 'text',
          text: 'done',
        },
      },
    }, '/proj');
    applyHarnessEventToSnapshot({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_a',
          sessionID: 'ses_a',
          role: 'assistant',
          providerID: 'claude-code',
          modelID: 'sonnet',
          time: { created: 1, completed: 2 },
        },
      },
    }, '/proj');
    applyHarnessEventToSnapshot({
      type: 'session.status',
      properties: { sessionID: 'ses_a', status: { type: 'idle' } },
    }, '/proj');

    expect(isHarnessSessionWorking('ses_a')).toBe(false);
    const snap = getHarnessTurnSnapshot('ses_a');
    expect(snap?.directory).toBe('/proj');
    expect(snap?.lastAssistant?.info?.modelID).toBe('sonnet');
    expect(getHarnessRecentMessages('ses_a')?.at(-1)?.parts?.[0]?.text).toBe('done');
  });

  it('marks aborted assistants', () => {
    applyHarnessEventToSnapshot({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_a',
          sessionID: 'ses_b',
          role: 'assistant',
          error: { name: 'MessageAbortedError' },
          time: { created: 1, completed: 2 },
        },
      },
    }, '/proj');
    expect(getHarnessTurnSnapshot('ses_b')?.aborted).toBe(true);
  });
});
