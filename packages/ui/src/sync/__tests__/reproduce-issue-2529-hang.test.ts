/**
 * Reproduction script for issue #2529.
 *
 * Demonstrates that `processVSCodePermissionAutoAccept()` hangs indefinitely
 * when any of its SDK calls (`getSession`, `fetchPermission`, `reply`) never
 * settles (neither resolves nor rejects), because none of these calls have
 * an AbortSignal / timeout.
 *
 * This hang is then amplified by `Promise.all` in
 * `resyncBlockingRequestsForDirectory` (sync-context.tsx:1237): when one
 * permission's auto-accept hangs, the entire bootstrap for that directory
 * hangs.
 */

import { describe, expect, mock, test } from "bun:test"
import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { createVSCodePermissionAutoAcceptRuntime } from "../vscode-permission-auto-accept"

const permission = { id: "perm-1", sessionID: "child" } as PermissionRequest
const session = (id: string, parentID?: string) => ({ id, parentID }) as Session

/**
 * A promise that never settles — simulates an SDK call that hangs.
 * This is the core of the bug: no timeout/AbortSignal means the caller
 * waits forever.
 */
const NEVER_SETTLES = new Promise<never>(() => {
  /* never resolves, never rejects */
})

describe("Issue #2529 — VS Code permission auto-accept hangs", () => {
  test("REPRODUCES: hangs when getSession never settles (no timeout)", async () => {
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ root: true }),
      getSessions: () => new Map(),
      // This never resolves → the bug
      getSession: async () => NEVER_SETTLES as Promise<Session>,
      listPendingPermissions: async () => [],
      getPermissionState: async () => "ok",
      reply: async () => undefined,
      wait: async () => undefined,
    })

    // With a 2s timeout, we prove the promise never settles.
    const result = await Promise.race([
      runtime.processPermission(permission, "/repo"),
      timeout(2000, "TIMEOUT: getSession hung forever"),
    ])

    expect(result).toBe("TIMEOUT: getSession hung forever")
  })

  test("REPRODUCES: hangs when fetchPermission (getPermissionState) never settles", async () => {
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ child: true }),
      getSessions: () => new Map(),
      getSession: async () => session("child"),
      listPendingPermissions: async () => [],
      // This never resolves → the bug
      getPermissionState: async () => NEVER_SETTLES as Promise<"ok" | "resolved" | "unknown">,
      reply: async () => undefined,
      wait: async () => undefined,
    })

    const result = await Promise.race([
      runtime.processPermission(permission),
      timeout(2000, "TIMEOUT: fetchPermission hung forever"),
    ])

    expect(result).toBe("TIMEOUT: fetchPermission hung forever")
  })

  test("REPRODUCES: hangs when reply never settles", async () => {
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ child: true }),
      getSessions: () => new Map(),
      getSession: async () => session("child"),
      listPendingPermissions: async () => [],
      getPermissionState: async () => "ok",
      // This never resolves → the bug
      reply: async () => NEVER_SETTLES as Promise<void>,
      wait: async () => undefined,
    })

    const result = await Promise.race([
      runtime.processPermission(permission),
      timeout(2000, "TIMEOUT: reply hung forever"),
    ])

    expect(result).toBe("TIMEOUT: reply hung forever")
  })

  test("REPRODUCES: Promise.all with one hanging permission blocks all", async () => {
    // This simulates the `resyncBlockingRequestsForDirectory` pattern:
    // `Promise.all(permissions.map(p => processPermission(p)))` at line 1237.
    // When one permission's auto-accept hangs, every permission waits.

    const replied: string[] = []

    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ child: true, child2: true }),
      getSessions: () => new Map([
        ["child", session("child", "root")],
        ["child2", session("child2", "root")],
      ]),
      getSession: async () => session("root"),
      listPendingPermissions: async () => [],
      getPermissionState: async (sessionId) => {
        // Permission for child2 hangs forever
        if (sessionId === "child2") {
          return NEVER_SETTLES as Promise<"ok" | "resolved" | "unknown">
        }
        return "ok"
      },
      reply: async (_sessionId, requestId) => { replied.push(requestId) },
      wait: async () => undefined,
    })

    // Simulate the Promise.all from resyncBlockingRequestsForDirectory
    const allPermissionsPromise = Promise.all([
      runtime.processPermission(
        { id: "perm-good", sessionID: "child" } as PermissionRequest,
      ),
      runtime.processPermission(
        { id: "perm-hangs", sessionID: "child2" } as PermissionRequest,
      ),
    ])

    // The entire batch should time out because one permission hangs
    const raceResult = await Promise.race([
      allPermissionsPromise,
      timeout(2000, "TIMEOUT: Promise.all hung because one permission never settles"),
    ])

    expect(raceResult).toBe(
      "TIMEOUT: Promise.all hung because one permission never settles",
    )
    // The good permission never got replied to either because Promise.all
    // never got far enough (or if it did, it was still blocked waiting
    // for the hanging one)
  })
})

function timeout<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}
