/**
 * Reproduction of issue #2521 from the session-runtime.js perspective.
 *
 * The server-side session runtime tracks each session's activity phase
 * independently. When a parent session transitions to idle while a child
 * (via parentID) is busy, the runtime does not maintain active-descendant
 * counts or propagate child activity to ancestors.
 */
import { beforeEach, describe, expect, test } from "bun:test";

/**
 * Simulates the core logic from session-runtime.js:
 * - sessionActivityPhases tracks each session independently
 * - updateSessionState checks only the session's own status
 * - No parentID lineage tracking for descendant activity propagation
 */

type PhaseEntry = { phase: string; updatedAt: number };

function simulateSessionRuntime() {
  const sessionActivityPhases = new Map<string, PhaseEntry>();
  let activeSessionCount = 0;

  const setSessionActivityPhase = (sessionId: string, phase: string) => {
    const current = sessionActivityPhases.get(sessionId);
    const wasActive = current?.phase === "busy";
    const isActive = phase === "busy";
    if (wasActive !== isActive) {
      activeSessionCount = Math.max(0, activeSessionCount + (isActive ? 1 : -1));
    }
    sessionActivityPhases.set(sessionId, { phase, updatedAt: Date.now() });
  };

  const updateSessionState = (sessionId: string, status: string) => {
    const phase = status === "busy" || status === "retry" ? "busy" : "idle";
    if (phase !== "idle" || sessionActivityPhases.get(sessionId)?.phase !== "cooldown") {
      setSessionActivityPhase(sessionId, phase);
    }
  };

  return {
    sessionActivityPhases,
    get activeSessionCount() {
      return activeSessionCount;
    },
    updateSessionState,
    getActivity: (sessionId: string) => sessionActivityPhases.get(sessionId)?.phase ?? "idle",
  };
}

/**
 * Helper to get parent IDs from a map of session → parentID.
 */
function getParentId(sessionId: string, parentMap: Map<string, string | null>): string | null {
  return parentMap.get(sessionId) ?? null;
}

describe("issue #2521 - session-runtime.js reproduction", () => {
  test("GAP: parent busy count goes to 0 when parent goes idle, ignoring busy child", () => {
    const runtime = simulateSessionRuntime();
    // parentMap: child-1's parentID → parent-1
    const parentMap = new Map<string, string | null>([
      ["child-1", "parent-1"],
    ]);

    // Parent becomes busy
    runtime.updateSessionState("parent-1", "busy");
    expect(runtime.activeSessionCount).toBe(1);

    // Child becomes busy (background subagent)
    runtime.updateSessionState("child-1", "busy");
    expect(runtime.activeSessionCount).toBe(2);

    // Parent transitions to idle (primary turn finished)
    runtime.updateSessionState("parent-1", "idle");

    // *** THE BUG ***
    // activeSessionCount drops to 1 (only child-1 is tracked),
    // but there is no derived "hasActiveDescendant" for parent-1.
    expect(runtime.activeSessionCount).toBe(1);
    expect(runtime.getActivity("parent-1")).toBe("idle");

    // The parent still shows idle despite child being busy.
    // There's no way to query "does parent-1 have busy descendants".
    // Expected: a mechanism to derive that parent-1 has active descendants.
    //
    // In the real SessionNodeItem (line 661-662):
    //   const statusType = sessionStatus?.type ?? 'idle';
    //   const isStreaming = statusType === 'busy' || statusType === 'retry';
    // parent-1 → statusType = 'idle' → isStreaming = false → NO SPINNER
  });

  test("GAP: active descendant chain is not maintained across retry updates", () => {
    const runtime = simulateSessionRuntime();
    const parentMap = new Map<string, string | null>([
      ["child-1", "parent-1"],
    ]);

    // Child goes busy, then retry
    runtime.updateSessionState("child-1", "busy");
    runtime.updateSessionState("child-1", "retry");

    expect(runtime.getActivity("child-1")).toBe("busy"); // retry maps to busy phase

    // Parent never went busy — still idle.
    expect(runtime.getActivity("parent-1")).toBe("idle");

    // No active descendants tracked for parent-1.
    // If we added descendant tracking, retry updates should not double-count.
  });

  test("GAP: idle cleanup does not cascade to ancestors", () => {
    const runtime = simulateSessionRuntime();
    const parentMap = new Map<string, string | null>([
      ["child-1", "parent-1"],
      ["grandchild-1", "child-1"],
    ]);

    // Grandchild busy → child busy → parent should be aware
    runtime.updateSessionState("grandchild-1", "busy");
    runtime.updateSessionState("child-1", "busy");

    expect(runtime.getActivity("child-1")).toBe("busy");
    expect(runtime.getActivity("parent-1")).toBe("idle"); // no descendant awareness

    // Child goes idle
    runtime.updateSessionState("child-1", "idle");

    // Grandchild still busy — but parent still has no descendant tracking.
    expect(runtime.getActivity("grandchild-1")).toBe("busy");
    expect(runtime.getActivity("parent-1")).toBe("idle");

    // Grandchild goes idle
    runtime.updateSessionState("grandchild-1", "idle");

    // Everything idle — correct final state but was wrong during child idle + grandchild busy
    expect(runtime.getActivity("child-1")).toBe("idle");
    expect(runtime.getActivity("parent-1")).toBe("idle");
  });

  test("GAP: activeSessionCount is also not ancestry-aware", () => {
    const runtime = simulateSessionRuntime();
    const parentMap = new Map<string, string | null>([
      ["child-1", "parent-1"],
    ]);

    runtime.updateSessionState("child-1", "busy");
    runtime.updateSessionState("parent-1", "busy");

    expect(runtime.activeSessionCount).toBe(2);

    // Parent goes idle
    runtime.updateSessionState("parent-1", "idle");

    // activeSessionCount goes to 1, correctly counting only child-1.
    // But the parent should be derivable as "has active work".
    // The current API has no way to ask this.
    expect(runtime.activeSessionCount).toBe(1);
  });
});
