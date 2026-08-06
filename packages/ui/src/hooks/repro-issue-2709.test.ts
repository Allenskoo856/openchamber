/**
 * Reproduction for issue #2709: "Queued messages send immediately if you view
 * a subagent session from the parent" (and the related #1451).
 *
 * The queue auto-send hook (`useQueuedMessageAutoSend`) flushes a session's
 * queued messages as soon as that session's status reads as `idle` (or is
 * missing entirely, which is coerced to `idle`). It has no awareness of the
 * agent delegation chain: when a primary agent hands a task to a subagent, the
 * parent session goes idle at the handoff while the subagent session is still
 * busy. The hook treats the handoff as a completion point and fires the queued
 * message immediately — even though the primary agent is logically still
 * working (it resumes once the subagent returns).
 *
 * This mounts the real hook with mocked stores and asserts:
 *  1. A message queued on a busy session is NOT sent while busy.
 *  2. After the parent goes idle at the delegation handoff (child subagent
 *     still busy), the queued message IS sent — the reported bug.
 *  3. A queued message on a session with *missing* status (a newly-viewed
 *     subagent session before status polling reports it busy) is sent
 *     immediately — same root cause.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Agent } from '@opencode-ai/sdk/v2';

const RUNTIME_KEY = 'runtime-test';
const DIRECTORY = '/repo';

let visibleAgents: Agent[] = [];
const sendMessageCalls: unknown[][] = [];

let statusRecord: Record<string, { type: string }> = {};
let currentDirectory = DIRECTORY;
let autoReviewRuns: Record<string, unknown> = {};
let isAutoReviewRunning = false;

const getVisibleAgentsMock = mock(() => visibleAgents);

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => RUNTIME_KEY,
}));

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: () => Promise.resolve(),
}));

mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({
      getVisibleAgents: getVisibleAgentsMock,
      currentAgentName: 'build',
      currentProviderId: 'provider-1',
      currentModelId: 'model-1',
    }),
  },
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      sendMessage: (...args: unknown[]) => {
        sendMessageCalls.push(args);
        return Promise.resolve();
      },
      sessionAbortFlags: new Map(),
    }),
  },
}));

mock.module('@/stores/contextStore', () => ({
  useContextStore: {
    getState: () => ({
      getSessionAgentSelection: () => 'build',
      getCurrentAgent: () => 'build',
      getSessionModelSelection: () => ({ providerId: 'provider-1', modelId: 'model-1' }),
      getAgentModelForSession: () => ({ providerId: 'provider-1', modelId: 'model-1' }),
      getAgentModelVariantForSession: () => undefined,
    }),
  },
}));

mock.module('@/sync/selection-store', () => ({
  useSelectionStore: {
    getState: () => ({
      lastUsedProvider: { providerID: 'provider-1', modelID: 'model-1' },
      getAgentModelVariantForSession: () => undefined,
    }),
  },
}));

mock.module('@/stores/useAutoReviewStore', () => ({
  useAutoReviewStore: Object.assign(
    (selector: (state: { runsByOriginalSessionID: Record<string, unknown> }) => unknown) =>
      selector({ runsByOriginalSessionID: autoReviewRuns }),
    {
      getState: () => ({
        runsByOriginalSessionID: autoReviewRuns,
        isRunningForSession: () => isAutoReviewRunning,
      }),
    },
  ),
}));

mock.module('@/sync/sync-refs', () => ({
  getDirectoryState: () => ({ session_status: statusRecord }),
}));

mock.module('@/stores/useDirectoryStore', () => ({
  useDirectoryStore: (selector: (state: { currentDirectory: string }) => unknown) =>
    selector({ currentDirectory }),
}));

// A subscribable mock of the directory sync store so status changes re-render
// the harness exactly like the real `useDirectorySync`/child-store wiring does.
let statusListeners = new Set<() => void>();
let statusSnapshot = { session_status: statusRecord };
const notifyStatusChange = () => {
  for (const listener of statusListeners) listener();
};

mock.module('@/sync/sync-context', () => ({
  useDirectorySync: (selector: (state: { session_status: Record<string, { type: string }> }) => unknown) => {
    const snapshot = React.useSyncExternalStore(
      (callback: () => void) => {
        statusListeners.add(callback);
        return () => statusListeners.delete(callback);
      },
      () => statusSnapshot,
      () => statusSnapshot,
    );
    return selector(snapshot);
  },
}));

import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useQueuedMessageAutoSend } from './useQueuedMessageAutoSend';

// --- Minimal DOM stub (Bun's test runner has no DOM by default) -----------

const installMinimalDom = () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  class ElementStub {}
  const documentStub: Record<string, unknown> = {
    nodeType: 9,
    defaultView: globalThis,
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const container = {
    nodeType: 1,
    tagName: 'DIV',
    nodeName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: documentStub,
    document: documentStub,
    HTMLIFrameElement: ElementStub,
    HTMLFrameSetElement: ElementStub,
    HTMLInputElement: ElementStub,
    HTMLTextAreaElement: ElementStub,
    HTMLSelectElement: ElementStub,
    HTMLOptionElement: ElementStub,
    HTMLAnchorElement: ElementStub,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  documentStub.documentElement = container;
  documentStub.body = container;
  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
  setGlobal('Element', ElementStub);
  setGlobal('HTMLElement', ElementStub);
  setGlobal('HTMLIFrameElement', ElementStub);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
  setGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  return {
    container: container as unknown as Element,
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const flush = async () => {
  // Let pending microtasks (the async dispatch path) and React's scheduled
  // callbacks settle inside act so store updates do not leak outside it.
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

// Install the DOM stub once for this file (each bun test file runs in its own
// process). Restoring it between tests would race React's scheduler callbacks.
const dom = installMinimalDom();

describe('reproduce issue #2709: queued messages flush at subagent delegation handoff', () => {
  let root: Root;

  beforeEach(() => {
    sendMessageCalls.length = 0;
    visibleAgents = [];
    statusRecord = {};
    statusSnapshot = { session_status: statusRecord };
    statusListeners = new Set();
    currentDirectory = DIRECTORY;
    autoReviewRuns = {};
    isAutoReviewRunning = false;
    useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
    root = createRoot(dom.container);
  });

  afterEach(async () => {
    try {
      await act(async () => {
        root.unmount();
      });
    } catch {
      // unmount on a torn-down stub DOM is irrelevant to the assertion
    }
  });

  const Harness = () => {
    useQueuedMessageAutoSend(true);
    return null;
  };

  const mountHarness = async () => {
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    await flush();
  };

  const setStatuses = async (next: Record<string, { type: string }>) => {
    statusRecord = next;
    await act(async () => {
      statusSnapshot = { session_status: statusRecord };
      notifyStatusChange();
    });
    await flush();
  };

  test('queued message on a busy parent session is held while the parent is busy', async () => {
    await mountHarness();

    await setStatuses({ 'parent-1': { type: 'busy' } });
    await act(async () => {
      useMessageQueueStore.getState().addToQueue(
        { runtimeKey: RUNTIME_KEY, directory: DIRECTORY, sessionId: 'parent-1' },
        { content: 'do this after the task completes' },
      );
    });
    await flush();

    expect(sendMessageCalls).toHaveLength(0);
  });

  test('BUG: queued message flushes the instant the parent goes idle at the delegation handoff while the subagent is still busy', async () => {
    await mountHarness();

    // Parent busy → queue holds.
    await setStatuses({ 'parent-1': { type: 'busy' } });
    await act(async () => {
      useMessageQueueStore.getState().addToQueue(
        { runtimeKey: RUNTIME_KEY, directory: DIRECTORY, sessionId: 'parent-1' },
        { content: 'queued on parent' },
      );
    });
    await flush();
    expect(sendMessageCalls).toHaveLength(0);

    // Parent delegates to subagent: parent session turns idle at the handoff,
    // subagent session is busy doing the delegated work.
    await setStatuses({
      'parent-1': { type: 'idle' },
      'child-1': { type: 'busy' },
    });

    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0]?.[0]).toBe('queued on parent');
    expect(sendMessageCalls[0]?.[9]).toEqual({ sessionId: 'parent-1', directory: DIRECTORY });
  });

  test('BUG: queued message on a session with missing status (newly-viewed subagent) sends immediately', async () => {
    await mountHarness();

    // Subagent session is being viewed but its status has not been reported
    // yet (no session.status event, no poll). The hook coerces missing → idle
    // and flushes the queue on the very first observation.
    await act(async () => {
      useMessageQueueStore.getState().addToQueue(
        { runtimeKey: RUNTIME_KEY, directory: DIRECTORY, sessionId: 'child-1' },
        { content: 'queued on subagent' },
      );
    });
    await flush();

    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0]?.[0]).toBe('queued on subagent');
    expect(sendMessageCalls[0]?.[9]).toEqual({ sessionId: 'child-1', directory: DIRECTORY });
  });
});
