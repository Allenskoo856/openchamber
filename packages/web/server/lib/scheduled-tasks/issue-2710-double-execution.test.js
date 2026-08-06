import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * Regression for https://github.com/openchamber/openchamber/issues/2710
 * "Scheduled daily task executes twice at the configured time"
 *
 * Root cause: each OpenChamber server process keeps its own timers. Two
 * instances that share the same on-disk project config (CLI serve on port 3000
 * + Electron on 57123, or a startup login service + desktop) each arm a timer
 * for the same occurrence and both dispatch.
 *
 * Fix: scheduled runs claim the occurrence in shared project config
 * (`lastScheduledFor` + advanced `nextRunAt`) under a cross-process write lock
 * before creating a session, so the second instance skips.
 */

const sdk = vi.hoisted(() => ({
  sessionCreates: [],
  createOpencodeClient: () => ({
    session: {
      create: async () => {
        sdk.sessionCreates.push(Date.now());
        return { data: { id: `sess-${sdk.sessionCreates.length}` } };
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
 * Shared on-disk store stand-in. Both runtimes must see the same task state so
 * occurrence claiming can serialize dispatches the way real project config does.
 */
const createSharedProjectConfigRuntime = (initialTask) => {
  let currentTask = structuredClone(initialTask);

  const applyPatch = (patch) => {
    currentTask = {
      ...currentTask,
      state: {
        ...(currentTask.state || {}),
        ...patch,
        updatedAt: Date.now(),
      },
    };
    return currentTask;
  };

  return {
    listScheduledTasks: vi.fn(async () => [structuredClone(currentTask)]),
    reconcileLoopTasks: vi.fn(async () => [structuredClone(currentTask)]),
    updateScheduledTaskState: vi.fn(async (_pid, _tid, patch) => {
      const task = applyPatch(patch);
      return { task: structuredClone(task), updated: true };
    }),
    updateScheduledTaskStateIf: vi.fn(async (_pid, _tid, predicate, patch) => {
      if (!predicate(currentTask)) {
        return { task: structuredClone(currentTask), updated: false };
      }
      const task = applyPatch(patch);
      return { task: structuredClone(task), updated: true };
    }),
    upsertScheduledTask: vi.fn(async (_pid, input) => {
      currentTask = structuredClone(input);
      return { task: structuredClone(currentTask) };
    }),
  };
};

const createRuntimeDeps = (projectConfigRuntime) => ({
  projectConfigRuntime,
  listProjects: vi.fn(async () => [{ id: 'p1', path: '/repo' }]),
  buildOpenCodeUrl: () => 'http://127.0.0.1:9999/',
  getOpenCodeAuthHeaders: () => ({}),
  waitForOpenCodeReady: async () => {},
  emitTaskRunEvent: vi.fn(),
  setSessionAutoAccept: async () => {},
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});

const startInstances = async (count, task) => {
  const projectConfigRuntime = createSharedProjectConfigRuntime(task);
  const runtimes = [];
  for (let i = 0; i < count; i += 1) {
    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    await runtime.start();
    runtimes.push(runtime);
  }
  return { runtimes, projectConfigRuntime };
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

  it('ONE instance fires a daily 15:00 task exactly once at 15:00', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 14, 0, 0));
    const { runtimes } = await startInstances(1, makeTask({ kind: 'daily', times: ['15:00'] }));
    await vi.advanceTimersByTimeAsync(HOUR + 3_000);

    expect(sdk.sessionCreates.length).toBe(1);
    const firedAt = new Date(sdk.sessionCreates[0]);
    expect(firedAt.getUTCHours()).toBe(15);

    runtimes.forEach((runtime) => runtime.stop());
  });

  it('ONE instance firing daily 15:00 across 4 days never double-fires', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 14, 0, 0));
    const { runtimes } = await startInstances(1, makeTask({ kind: 'daily', times: ['15:00'] }));
    await vi.advanceTimersByTimeAsync((4 * 24 * HOUR) + 3_000);

    expect(sdk.sessionCreates.length).toBe(4);
    const byHourBucket = new Map();
    for (const timestamp of sdk.sessionCreates) {
      const date = new Date(timestamp);
      expect(date.getUTCHours()).toBe(15);
      expect(date.getUTCMinutes()).toBe(0);
      const bucket = Math.floor(timestamp / HOUR);
      byHourBucket.set(bucket, (byHourBucket.get(bucket) || 0) + 1);
    }
    for (const count of byHourBucket.values()) {
      expect(count).toBe(1);
    }

    runtimes.forEach((runtime) => runtime.stop());
  });

  it('TWO instances fire a daily 15:00 task exactly ONCE (occurrence claim)', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 14, 0, 0));
    const { runtimes, projectConfigRuntime } = await startInstances(
      2,
      makeTask({ kind: 'daily', times: ['15:00'] }),
    );
    await vi.advanceTimersByTimeAsync(HOUR + 3_000);

    expect(sdk.sessionCreates.length).toBe(1);
    const firedAt = new Date(sdk.sessionCreates[0]);
    expect(firedAt.getUTCHours()).toBe(15);
    expect(firedAt.getUTCMinutes()).toBe(0);
    expect(projectConfigRuntime.updateScheduledTaskStateIf).toHaveBeenCalled();

    runtimes.forEach((runtime) => runtime.stop());
  });

  it('TWO instances fire a weekly task exactly once', async () => {
    // 2026-01-04 is a Sunday. Weekly Mon/Wed/Fri 09:00.
    vi.setSystemTime(UTC(2026, 0, 4, 8, 0, 0));
    const { runtimes } = await startInstances(2, makeTask({
      kind: 'weekly',
      times: ['09:00'],
      weekdays: [1, 3, 5],
    }));
    await vi.advanceTimersByTimeAsync((25 * HOUR) + 3_000);

    expect(sdk.sessionCreates.length).toBe(1);

    runtimes.forEach((runtime) => runtime.stop());
  });

  it('TWO instances fire a cron task exactly once', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 14, 3, 0));
    const { runtimes } = await startInstances(2, makeTask({ kind: 'cron', cron: '*/5 * * * *' }));
    await vi.advanceTimersByTimeAsync(3 * MINUTE);

    expect(sdk.sessionCreates.length).toBe(1);

    runtimes.forEach((runtime) => runtime.stop());
  });

  it('TWO instances fire a once task exactly once', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 8, 0, 0));
    const { runtimes } = await startInstances(2, makeTask({
      kind: 'once',
      date: '2026-01-01',
      time: '09:00',
    }));
    await vi.advanceTimersByTimeAsync(HOUR + 3_000);

    expect(sdk.sessionCreates.length).toBe(1);

    runtimes.forEach((runtime) => runtime.stop());
  });
});
