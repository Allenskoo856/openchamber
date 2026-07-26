import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionGoalRuntime } from './runtime.js';

const SESSION_ID = 'ses_claude';
const DIRECTORY = '/workspace';

const goal = {
  id: 'goal_1',
  objective: 'Finish the task',
  status: 'active',
  turnsUsed: 0,
  createdAt: 1,
  updatedAt: 1,
};

const session = {
  id: SESSION_ID,
  directory: DIRECTORY,
  metadata: { openchamber: { goal } },
};

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const requestPath = (input) => new URL(typeof input === 'string' ? input : input.url).pathname;

describe('session goal Claude harness continuation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('continues Claude sessions via promptHarness using turn snapshot messages', async () => {
    const promptHarness = vi.fn(async () => ({ ok: true, status: 'started' }));
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"Keep going"}',
        providerID: 'provider',
        modelID: 'model',
      })),
    };
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse(session);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      throw new Error(`Unexpected OpenCode request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);

    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => service,
      idleQuietMs: 10,
      getHarnessBinding: () => ({
        harnessId: 'claude-code',
        directory: DIRECTORY,
        target: { harnessId: 'claude-code', modelRef: 'sonnet', permissionMode: 'acceptEdits' },
      }),
      isHarnessSessionWorking: () => false,
      getHarnessRecentMessages: () => ([{
        info: {
          id: 'msg_assistant',
          sessionID: SESSION_ID,
          role: 'assistant',
          providerID: 'claude-code',
          modelID: 'sonnet',
          time: { completed: 2 },
          tokens: { input: 0, output: 0, cache: { read: 0 } },
        },
        parts: [{ type: 'text', text: 'Working on the objective.' }],
      }]),
      promptHarness,
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(promptHarness).toHaveBeenCalledOnce();
    expect(promptHarness.mock.calls[0][0]).toMatchObject({
      sessionId: SESSION_ID,
      directory: DIRECTORY,
      target: {
        harnessId: 'claude-code',
        modelRef: 'sonnet',
        permissionMode: 'acceptEdits',
      },
    });
    expect(String(promptHarness.mock.calls[0][0].text)).toContain('Continue working toward the active session goal');
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('prompt_async'))).toBe(false);
    runtime.stop();
  });
});
