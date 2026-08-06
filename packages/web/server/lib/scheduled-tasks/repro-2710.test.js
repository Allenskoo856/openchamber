import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/2710
 * "Scheduled daily task executes twice at the configured time"
 *
 * Mechanism: the scheduled-tasks runtime keeps its timers in process-local
 * Maps (`timersByTaskKey`, `runningTaskKeys`, ...) and never coordinates with
 * any other OpenChamber server process. Two server instances that share the
 * same on-disk project config each schedule and fire the same task, so a
 * daily task at 15:00 dispatches two runs at 15:00.
 *
 * Two real-world instances can coexist because the guards are per-port:
 *   - CLI `openchamber serve` / `openchamber startup enable` login service: port 3000
 *   - Electron desktop in-process server: port 57123 (DEFAULT_DESKTOP_PORT)
 */

const sdk = vi.hoisted(() => ({
  sessionCreates: [],
  createOpencodeClient: () => ({
    session: {
      create: async () => {
        sdk.sessionCreates.push(Date.now());
        return { data: { id: 'sess-' + sdk.sessionCreates.length } };
      },
    },
    command: { list: async () => ({ data: [] }) },
  }),
}));

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: sdk.createOpencodeClient,
}));

import { createScheduledTasksRuntime } from './runtime.js';

const UTC = (y, mo, d, h, mi, s = 0) => Date.UTC(y, mo, d, h, mi, s);
const MINUTE = 60_000;
const HOUR = 3_600_000;

const makeTask = (schedule) => ({
  id: 'task-1',
  name: 'Daily Sync',
  enabled: true,
  schedule: { timezone: 'UTC', ...schedule },
  execution: { prompt: 'Summarize open issues', providerID: 'openai', modelID: 'gpt-4o' },
  state: { createdAt: UTC(2026, 0, 1, 0, 0, 0), updatedAt: UTC(2026, 0, 1, 0, 0, 0) },
});

/**
 * Builds an independent server-instance dependency set. Each instance gets its
 * own runtime closure (own timers, own guard sets) exactly like two separate
 * processes; they only share the on-disk task store abstraction.
 */
const createInstanceDeps = (initialTask) => {
  let currentTask = structuredClone(initialTask);
  return {
    projectConfigRuntime: {
      listScheduledTasks: vi.fn(async () => [currentTask]),
      updateScheduledTaskState: vi.fn(async (_pid, _tid, patch) => {
        currentTask = {
          ...currentTask,
          state: { ...(currentTask.state || {}), ...patch, updatedAt: Date.now() },
        };
        return { task: currentTask };
      }),
      upsertScheduledTask: vi.fn(async (_pid, input) => {
        currentTask = input;
        return { task: input };
      }),
    },
    listProjects: vi.fn(async () => [{ id: 'p1', path: '/repo' }]),
    buildOpenCodeUrl: () => 'http://127.0.0.1:9999/',
    getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: async () => {},
    emitTaskRunEvent: vi.fn(),
    setSessionAutoAccept: async () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
};

const startInstances = async (count, task) => {
  const runtimes = [];
  for (let i = 0; i < count; i += 1) {
    const deps = createInstanceDeps(task);
    const runtime = createScheduledTasksRuntime(deps);
    await runtime.start();
    runtimes.push(runtime);
  }
  return runtimes;
};

describe('issue 2710: daily scheduled task double execution at the configured time', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sdk.sessionCreates.length = 0;
    globalThis.fetch = vi.fn(async () => ({ ok: true, text: async () => '' }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('control: ONE instance fires a daily 15:00 task exactly once at 15:00', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 14, 0, 0)); // 14:00
    const runtimes = await startInstances(1, makeTask({ kind: 'daily', times: ['15:00'] }));
    await vi.advanceTimersByTimeAsync(HOUR + 3_000); // cross 15:00

    expect(sdk.sessionCreates.length).toBe(1);
    const firedAt = new Date(sdk.sessionCreates[0]);
    expect(firedAt.getUTCHours()).toBe(15);

    runtimes.forEach((r) => r.stop());
  });

  it('control: ONE instance firing daily 15:00 across 4 days never double-fires (once per day)', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 14, 0, 0)); // 14:00
    const runtimes = await startInstances(1, makeTask({ kind: 'daily', times: ['15:00'] }));
    await vi.advanceTimersByTimeAsync(4 * 24 * HOUR + 3_000); // 4 days

    expect(sdk.sessionCreates.length).toBe(4);
    const byHourBucket = new Map();
    for (const t of sdk.sessionCreates) {
      const d = new Date(t);
      expect(d.getUTCHours()).toBe(15);
      expect(d.getUTCMinutes()).toBe(0);
      byHourBucket.set(Math.floor(t / HOUR), (byHourBucket.get(Math.floor(t / HOUR)) || 0) + 1);
    }
    for (const [, count] of byHourBucket) expect(count).toBe(1);

    runtimes.forEach((r) => r.stop());
  });

  it('BUG: TWO instances fire a daily 15:00 task TWICE at 15:00 (one run per instance)', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 14, 0, 0)); // 14:00
    const runtimes = await startInstances(2, makeTask({ kind: 'daily', times: ['15:00'] }));
    await vi.advanceTimersByTimeAsync(HOUR + 3_000); // cross 15:00

    const fires = sdk.sessionCreates.map((t) => new Date(t).toISOString());
    // Reported symptom: two dispatches at the configured time.
    expect(sdk.sessionCreates.length).toBe(2);
    for (const t of fires) {
      const d = new Date(t);
      expect(d.getUTCHours()).toBe(15);
      expect(d.getUTCMinutes()).toBe(0);
    }

    runtimes.forEach((r) => r.stop());
  });

  it('BUG: TWO instances double-fire weekly tasks as well (same uncoordinated pattern)', async () => {
    // 2026-01-04 is a Sunday. Weekly Mon/Wed/Fri 09:00.
    vi.setSystemTime(UTC(2026, 0, 4, 8, 0, 0));
    const runtimes = await startInstances(2, makeTask({
      kind: 'weekly',
      times: ['09:00'],
      weekdays: [1, 3, 5],
    }));
    // First occurrence is Monday 09:00, 25 hours from Sunday 08:00.
    await vi.advanceTimersByTimeAsync(25 * HOUR + 3_000); // cross Monday 09:00

    expect(sdk.sessionCreates.length).toBe(2);

    runtimes.forEach((r) => r.stop());
  });

  it('BUG: TWO instances double-fire cron tasks as well (same uncoordinated pattern)', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 14, 3, 0));
    const runtimes = await startInstances(2, makeTask({ kind: 'cron', cron: '*/5 * * * *' }));
    await vi.advanceTimersByTimeAsync(3 * MINUTE); // cross the 14:05 slot

    expect(sdk.sessionCreates.length).toBe(2);

    runtimes.forEach((r) => r.stop());
  });

  it('BUG: TWO instances double-fire once tasks as well', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 8, 0, 0));
    const runtimes = await startInstances(2, makeTask({
      kind: 'once',
      date: '2026-01-01',
      time: '09:00',
    }));
    await vi.advanceTimersByTimeAsync(HOUR + 3_000); // cross 09:00

    expect(sdk.sessionCreates.length).toBe(2);

    runtimes.forEach((r) => r.stop());
  });
});
