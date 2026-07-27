/**
 * Reproduction for issue #2470: Sessions stuck on "loading sessions" forever
 *
 * Root cause chain:
 * 1. OpenCode SDK client is created without any fetch timeout / AbortSignal
 *    (packages/ui/src/lib/opencode/client.ts:185 - createRuntimeOpencodeClient)
 * 2. runtimeFetch (packages/ui/src/lib/runtime-fetch.ts:245) forwards requestInit
 *    straight to fetch and never injects a timeout signal.
 * 3. When the managed OpenCode connection goes half-open, session.list fetch never
 *    resolves AND never rejects — it hangs indefinitely.
 * 4. retry() (packages/ui/src/sync/retry.ts) only retries on REJECTION, so it hangs too.
 * 5. onBootstrap promise (sync-context.tsx:1854) never settles.
 * 6. pumpBootstrapQueue (child-store.ts:562) releases its concurrency slot only in
 *    the promise's .finally() — which never fires for a hanging promise.
 * 7. bootstrapConcurrency = 2, so two hung directories occupy both slots → all
 *    other directories stay "queued" forever.
 * 8. SessionGroupSection.tsx:970 renders the "loading sessions" spinner while
 *    bootstrapState is "queued"/"running", so it spins forever.
 */

import { describe, expect, test } from 'bun:test';
import { ChildStoreManager } from './child-store';

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, rej) => {
    resolve = next;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('Reproduction: Issue #2470 - hanging bootstrap blocks queue forever', () => {
  test('BUG: hanging onBootstrap never settles, blocking all other directories forever', async () => {
    const manager = new ChildStoreManager();
    const pendingResolvers: ((value: unknown) => void)[] = [];
    const started: string[] = [];

    const cleanup = manager.configure({
      bootstrapConcurrency: 2,
      onBootstrap: ({ directory }) => {
        // Simulate a hanging fetch that never settles (half-open socket scenario)
        started.push(directory);
        return new Promise<void>((_resolve) => {
          // Store the resolver so we can clean up later, but NEVER call it
          // during the test — this is the hanging (half-open socket) scenario
          pendingResolvers.push(_resolve as (value: unknown) => void);
        });
      },
    });

    // Queue 4 directories in a single call (setBootstrapDemand replaces ALL
    // demands for a given owner, so must pass all at once)
    manager.setBootstrapDemand('sidebar', Array.from({ length: 4 }, (_, i) => ({
      directory: `/project-${i}`,
      priority: 'expanded' as const,
      reason: 'project-expanded' as const,
    })));

    // Let the bootstrap queue pump start the first two (concurrency = 2)
    await settle();

    // First two directories should be running
    expect(started.length).toBe(2);
    expect(manager.getBootstrapState('/project-0')).toBe('running');
    expect(manager.getBootstrapState('/project-1')).toBe('running');

    // The remaining two should be stuck in "queued" forever
    // because no concurrency slots will ever free up
    expect(manager.getBootstrapState('/project-2')).toBe('queued');
    expect(manager.getBootstrapState('/project-3')).toBe('queued');

    // Verify they stay queued even after more time passes
    await settle();
    await settle();
    expect(started.length).toBe(2); // Still only 2 started
    expect(manager.getBootstrapState('/project-2')).toBe('queued');
    expect(manager.getBootstrapState('/project-3')).toBe('queued');

    // Clean up: resolve all hanging promises so the test can finish
    for (const resolve of pendingResolvers) {
      resolve(undefined);
    }
    await settle();
    await settle();
    cleanup();
    manager.disposeAll();
  });

  test('CONTRAST: a properly failing bootstrap (with rejection) does NOT block the queue', async () => {
    const manager = new ChildStoreManager();
    const started: string[] = [];

    const cleanup = manager.configure({
      bootstrapConcurrency: 2,
      onBootstrap: async ({ directory }) => {
        started.push(directory);
        // Reject immediately — simulates a fetch that fails with an error (rejects)
        throw new Error('simulated network error');
      },
    });

    // Queue 4 directories in a single call
    manager.setBootstrapDemand('sidebar', Array.from({ length: 4 }, (_, i) => ({
      directory: `/project-${i}`,
      priority: 'expanded' as const,
      reason: 'project-expanded' as const,
    })));

    // Let all bootstraps run — they all fail but release slots
    await settle();
    await settle();
    await settle();
    await settle();

    // All directories should have been attempted
    expect(started.length).toBe(4);

    // All should be marked "failed" (not stuck in "running"/"queued")
    expect(manager.getBootstrapState('/project-0')).toBe('failed');
    expect(manager.getBootstrapState('/project-1')).toBe('failed');
    expect(manager.getBootstrapState('/project-2')).toBe('failed');
    expect(manager.getBootstrapState('/project-3')).toBe('failed');

    cleanup();
    manager.disposeAll();
  });
});

describe('Reproduction: Issue #2470 - \'terminated\' not in retry TRANSIENT_MESSAGES', () => {
  test('BUG: retry() does NOT retry when error includes "terminated"', async () => {
    // When an OpenCode half-open connection finally does get terminated,
    // the fetch rejects with 'TypeError: terminated'. But retry.ts only
    // retries messages containing the substrings in its TRANSIENT_MESSAGES
    // array. 'terminated' is NOT in that list, so even if the client-side
    // did time out and reject, the error wouldn't be retried — retry gives
    // up after the first attempt instead of retrying.
    const { retry } = await import('./retry');

    let attempts = 0;
    const terminatedFn = async (): Promise<string> => {
      attempts++;
      throw new Error('TypeError: terminated');
    };

    try {
      await retry(terminatedFn, { attempts: 3, delay: 10 });
    } catch {
      // Expected
    }

    // 'terminated' is not in TRANSIENT_MESSAGES, so retry should fail
    // after just 1 attempt (not 3)
    expect(attempts).toBe(1);
  });

  test('CONTRAST: retry() DOES retry when error includes "socket hang up"', async () => {
    const { retry } = await import('./retry');

    let attempts = 0;
    const hangUpFn = async (): Promise<string> => {
      attempts++;
      throw new Error('socket hang up');
    };

    try {
      await retry(hangUpFn, { attempts: 3, delay: 10 });
    } catch {
      // Expected
    }

    // 'socket hang up' IS in TRANSIENT_MESSAGES, so retry should retry
    // all 3 attempts
    expect(attempts).toBe(3);
  });
});

describe('Reproduction: Issue #2470 - retry() hangs when underlying promise never settles', () => {
  test('BUG: retry() hangs forever when the wrapped function never settles', async () => {
    const { retry } = await import('./retry');

    // Create a function that never settles (neither resolves nor rejects)
    const hangingFn = async (): Promise<string> => {
      return new Promise<string>(() => {
        // Never resolve, never reject — hangs forever
      });
    };

    // retry() will hang because it only retries on catch/rejection,
    // but hangingFn never settles at all
    const result = retry(hangingFn, { attempts: 3, delay: 100 });

    // The promise should NOT settle within a reasonable timeout
    const timeout = new Promise<{ hung: boolean }>((resolve) => {
      setTimeout(() => resolve({ hung: true }), 500);
    });

    const raceResult = await Promise.race([
      result.then(() => ({ hung: false })),
      timeout,
    ]);

    // If we get here, retry hung as expected (the race resolved via timeout)
    expect(raceResult.hung).toBe(true);
  });

  test('CONTRAST: retry() properly retries when the wrapped function rejects', async () => {
    const { retry } = await import('./retry');

    let attempts = 0;
    const rejectingFn = async (): Promise<string> => {
      attempts++;
      throw new Error('socket hang up');
    };

    // This should reject after exhausting retries (not hang)
    // retry with attempts: 3 means 3 total tries
    try {
      await retry(rejectingFn, { attempts: 3, delay: 10 });
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      // Expected: error is thrown after all retries are exhausted
      expect(attempts).toBe(3);
      expect(String(error)).toContain('socket hang up');
    }
  });
});
