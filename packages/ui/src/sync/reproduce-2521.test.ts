/**
 * Reproduction test for issue #2521:
 * Background subagent leaves parent session shown idle while child is still working.
 *
 * Current `main` (9c54906) gap: global-session-status.ts indexes session statuses
 * independently and does not maintain active-descendant counts, so a parent whose
 * status is authoritatively `idle` gets no spinner even when a child (or deeper
 * descendant) via parentID is still `busy`/`retry`.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Event, SessionStatus } from "@opencode-ai/sdk/v2/client";
import {
  applyGlobalSessionStatusEvent,
  useGlobalSessionStatusStore,
} from "./global-session-status";
import { resetSessionOrdering } from "./session-ordering";

beforeEach(() => {
  useGlobalSessionStatusStore.setState({ statusById: new Map() });
  resetSessionOrdering();
});

describe("issue #2521 - background subagent idle parent reproduction", () => {
  test("GAP: parent session shows idle when child is busy (no descendant tracking)", () => {
    // Simulate: parent session 'parent-1' turns idle, child session 'child-1'
    // (whose parentID points to 'parent-1') is still busy.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "parent-1", status: { type: "idle" } },
    } as Event);
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "child-1", status: { type: "busy" } },
    } as Event);

    const state = useGlobalSessionStatusStore.getState();

    // Child is tracked as busy — this is correct.
    expect(state.statusById.get("child-1")?.status.type).toBe("busy");

    // Parent is authoritatively idle — the store correctly reflects what
    // OpenCode emitted. There is NO active-descendant count maintained.
    expect(state.statusById.has("parent-1")).toBe(false);

    // *** THIS IS THE BUG ***
    // SessionNodeItem reads only useGlobalSessionStatus(session.id) for the
    // spinner. Since parent-1 has no entry in statusById, it shows no spinner
    // even though child-1 (a descendant via parentID) is still busy.
    //
    // Expected: parent-1 should be derivable as "has active work" because
    // child-1 (whose parentID points to parent-1) is still busy.
    //
    // The store needs a separate active-descendant index so consumers can
    // call something like hasActiveDescendant('parent-1') → true.
  });

  test("GAP: two levels of nesting (parent idle, child busy, grandchild busy)", () => {
    // Simulate: grandparent 'gp-1' idle, parent 'p-1' idle,
    // child 'c-1' busy (c-1's parentID → p-1, p-1's parentID → gp-1).
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "gp-1", status: { type: "idle" } },
    } as Event);
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "p-1", status: { type: "idle" } },
    } as Event);
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "c-1", status: { type: "busy" } },
    } as Event);

    const state = useGlobalSessionStatusStore.getState();

    // Only c-1 appears in the active status store.
    expect(state.statusById.has("c-1")).toBe(true);
    expect(state.statusById.has("p-1")).toBe(false);
    expect(state.statusById.has("gp-1")).toBe(false);

    // *** THE BUG: ***
    // Neither p-1 nor gp-1 can derive active-descendant state from the
    // current index because the store has no parentID chain resolution.
    // Both should show as "has active background work" via descendant roll-up.
  });

  test("GAP: retry child does not propagate up either", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "parent-1", status: { type: "idle" } },
    } as Event);
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: {
        sessionID: "child-1",
        status: { type: "retry", attempt: 1, message: "waiting", next: 5000 },
      },
    } as Event);

    const state = useGlobalSessionStatusStore.getState();

    // Child is retry — tracked correctly.
    expect(state.statusById.get("child-1")?.status.type).toBe("retry");

    // Parent is idle — no active-descendant awareness.
    expect(state.statusById.has("parent-1")).toBe(false);

    // The sidebar spinner in SessionNodeItem (line 661-662) checks:
    //   const statusType = sessionStatus?.type ?? 'idle';
    //   const isStreaming = statusType === 'busy' || statusType === 'retry';
    // Parent-1's statusType will be 'idle' → no spinner.
  });

  test("GAP: unrelated session with same idle status is not affected (no false positive)", () => {
    // Unrelated session 'other-1' has no parentID relation to any busy child.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "other-1", status: { type: "idle" } },
    } as Event);
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "child-1", status: { type: "busy" } },
    } as Event);

    const state = useGlobalSessionStatusStore.getState();

    // Both sessions tracked independently.
    expect(state.statusById.has("other-1")).toBe(false); // idle → removed
    expect(state.statusById.get("child-1")?.status.type).toBe("busy");

    // Current code has no concept of parentID chains, so there's no false
    // positive for 'other-1' — but there's also no true positive for a
    // parent that should have active-descendant awareness.
  });

  test("GAP: useSessionActivity returns idle for parent with busy child", () => {
    // This test demonstrates the gap at the hook level. The hook reads
    // session_status from the directory-scoped child store (not the global
    // store), but the same problem exists: the hook checks only the
    // selected session's own status, not its descendants.
    //
    // The hook (useSessionActivity.ts line 43-58):
    //   1. Reads status?.type ?? 'idle'
    //   2. If hasAuthoritativeStatus && !statusWorking → returns IDLE_RESULT
    //
    // When the parent's authoritative status is idle, the hook returns idle
    // regardless of any child activity.
    //
    // This is correct behavior per the current design, but the expected
    // behavior per the issue is that parent presentation should be aware
    // of descendant activity without changing the parent's authoritative status.
  });
});
