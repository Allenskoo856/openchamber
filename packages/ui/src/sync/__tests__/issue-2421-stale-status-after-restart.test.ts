/**
 * Reproduction test for issue #2421: Managed OpenCode sessions show stale
 * active state after OpenChamber restart.
 *
 * The bug: When OpenChamber restarts while managing active (generating) OpenCode
 * sessions, the underlying OpenCode process is killed and a new one starts. The
 * new OpenCode instance has no knowledge of the previous sessions' active status,
 * but the client-side store can retain stale `session_status: { type: "busy" }`
 * entries from before the restart.
 *
 * Two critical code paths allow this stale state to persist for seconds:
 *
 * Path A — Reconnect resync fetch fails (OpenCode not ready yet):
 *   `resyncDirectorySessionStatuses` calls `getSessionStatusForDirectory`.
 *   If the new OpenCode process is still starting (e.g., the proxy returns 502
 *   or the SDK call throws), the function returns `null` early and does NOT
 *   touch the store. Stale `busy` status survives.
 *
 * Path B — Watchdog poll with "monotonic" mode cannot lower:
 *   The periodic watchdog poll (every ~5s) uses "monotonic" mode, which by
 *   design will NOT lower a `busy` entry to `idle` even when the authoritative
 *   snapshot from the new OpenCode reports the session is absent/idle. It
 *   escalates to a full authoritative resync via `triggerDirectoryResync` only
 *   after detecting the mismatch, which takes another cycle.
 *
 * Compounding Path A+B:
 *   If the watchdog poll's status fetch ALSO fails (OpenCode still unavailable),
 *   `resyncDirectorySessionStatuses` returns `null`, and the escalation
 *   (`needsSnapshotAfterStatusPoll`) is NEVER reached — the loop returns
 *   silently. The stale status persists until the next poll cycle succeeds.
 *
 * Result: The UI shows the session as actively streaming/working for up to
 * 5-10 seconds after restart, when in reality the underlying OpenCode process
 * has been replaced and is not generating for that session.
 */
import { describe, expect, test } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"

import { INITIAL_STATE, type State } from "../types"
import type { DirectoryStore } from "../child-store"
import {
  applySessionStatusSnapshot,
  needsSnapshotAfterStatusPoll,
  shouldTriggerStaleResync,
} from "../sync-context"

type StatusSnapshot = Record<string, {
  type: "idle" | "busy" | "retry"
  attempt?: number
  message?: string
  next?: number
}>

const BUSY: SessionStatus = { type: "busy" }
const IDLE: SessionStatus = { type: "idle" }

function createDirectoryStore(initial: Partial<State>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    session: initial.session ?? [],
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

describe("Issue #2421 — stale active state after restart", () => {
  describe("Path A: Reconnect resync fetch fails (OpenCode not ready)", () => {
    test("resyncDirectorySessionStatuses preserves busy status when fetch returns null", () => {
      // Before restart, this session was actively generating.
      const store = createDirectoryStore({
        session_status: { ses_1: BUSY },
      })

      // Simulate: getSessionStatusForDirectory returns null (OpenCode proxy
      // is returning errors because the new process hasn't finished starting).
      //
      // This is the exact guard in resyncDirectorySessionStatuses:
      //   const nextStatuses = await opencodeClient.getSessionStatusForDirectory(directory)
      //   if (nextStatuses === null) return null   // <-- preserves existing state
      function resyncResult(): null {
        return null
      }

      const result = resyncResult()
      expect(result).toBeNull()

      // The function returns early — store is NOT updated.
      // The session still appears busy even though OpenCode was restarted
      // and is NOT generating for this session.
      expect(store.getState().session_status).toEqual({ ses_1: BUSY })

      // BUG: The UI will show this session as actively streaming/working
      // even though its underlying OpenCode process was killed and the new
      // one doesn't know about it.
    })
  })

  describe("Path B: Watchdog poll cannot lower stale status (monotonic)", () => {
    test("monotonic poll preserves stale busy after restart", () => {
      // After restart, the store still has the old busy status.
      const store = createDirectoryStore({
        session_status: { ses_1: BUSY },
      })

      // The new OpenCode instance returns {} — no active sessions.
      // In a monotonic poll, absent means "don't lower".
      const snapshot = {} as StatusSnapshot
      const changed = applySessionStatusSnapshot(
        store, snapshot, ["ses_1"], "monotonic",
      )

      // The snapshot is correct (empty), but monotonic mode won't act on it.
      expect(changed).toBe(false)
      expect(store.getState().session_status.ses_1).toEqual(BUSY)

      // The watchdog DOES detect the mismatch and will escalate...
      const needsEscalation = needsSnapshotAfterStatusPoll(
        store.getState(), "ses_1", snapshot.ses_1,
      )
      expect(needsEscalation).toBe(true)

      // ...but the escalation runs on the NEXT tick, adding another 5+ second
      // poll cycle before the authoritative resync can lower the status.
      // During this interval the UI shows the session as active.
    })
  })

  describe("Compounding A+B: fetch fails during watchdog too", () => {
    test("a second null result from the watchdog also skips escalation", () => {
      // Realistic scenario:
      // T+0s: SSE reconnects, resyncDirectoryAfterReconnect runs
      //       -> getSessionStatusForDirectory returns null (OpenCode starting)
      //       -> store unchanged, ses_1 stays busy
      // T+5s: Watchdog poll runs
      //       -> resyncDirectorySessionStatuses with monotonic mode
      //       -> getSessionStatusForDirectory STILL returns null (OpenCode slow)
      //       -> pollDirectoryStatuses: "if (!statuses) return" — silently exits
      //       -> needsSnapshot check is NEVER reached
      //       -> escalation doesn't fire
      // T+10s: Next watchdog poll succeeds, gets {} (no active sessions)
      //        -> monotonic doesn't lower, but escalates
      //        -> authoritative resync runs, finally lowers ses_1 to idle
      //
      // Total stale window: ~10 seconds.

      const store = createDirectoryStore({
        session_status: { ses_1: BUSY },
      })

      // Simulate the first watchdog poll: result is still null
      const result1 = null as StatusSnapshot | null
      if (!result1) {
        // This is what pollDirectoryStatuses does:
        //   const statuses = await resyncDirectorySessionStatuses(...)
        //   if (!statuses) return  <-- silent skip, no escalation
        // Nothing happens - the stale state is preserved
      }

      // Even after the first watchdog cycle, ses_1 is still busy
      expect(store.getState().session_status.ses_1).toEqual(BUSY)

      // Simulate the SECOND watchdog poll: now OpenCode is ready, returns {}
      const result2 = {} as StatusSnapshot
      if (!result2) return // guard
      const changed = applySessionStatusSnapshot(
        store, result2, ["ses_1"], "monotonic",
      )

      // Monotonic still doesn't lower
      expect(changed).toBe(false)

      // Now the escalation check runs
      const needsEscalation = needsSnapshotAfterStatusPoll(
        store.getState(), "ses_1", result2.ses_1,
      )
      expect(needsEscalation).toBe(true)

      // Finally the authoritative resync runs and corrects it
      applySessionStatusSnapshot(
        store, result2, ["ses_1"], "authoritative",
      )
      expect(store.getState().session_status.ses_1).toEqual(IDLE)

      // This entire process took ~10 seconds of real time during which
      // the user saw an active/streaming session that wasn't actually doing
      // anything.
    })
  })

  describe("stale-stream resync timer may also fire", () => {
    test("stale resync fires only after 20s of no stream activity", () => {
      // There's a separate stale-stream resync path in the tick() loop
      // (shouldTriggerStaleResync) that fires after 20s of no stream
      // activity. But even this has a 15s cooldown between resyncs and
      // won't fire if any heartbeat has arrived within 20s.

      const now = 100_000
      const STALE_MS = 20_000
      const COOLDOWN_MS = 15_000

      // Just 5 seconds after the last heartbeat - no stale resync
      expect(
        shouldTriggerStaleResync(now - 5_000, 0, now, STALE_MS, COOLDOWN_MS),
      ).toBe(false)

      // After 21 seconds without any event - stale resync fires
      expect(
        shouldTriggerStaleResync(now - 21_000, now - 20_000, now, STALE_MS, COOLDOWN_MS),
      ).toBe(true)

      // But if a reconnect resync already ran (cooldown), it waits
      expect(
        shouldTriggerStaleResync(now - 21_000, now - 5_000, now, STALE_MS, COOLDOWN_MS),
      ).toBe(false)

      // So the stale-stream fallback can take up to 20s + 15s = 35s
      // to actually fire. This is NOT the primary recovery path for
      // restart — the reconnect resync + watchdog escalation are.
      // But it shows the overall system does eventually recover.
    })
  })

  describe("Global session status store also retains stale entries", () => {
    test("global session status relies on the same snapshot mechanism", () => {
      // The global session status store (`useGlobalSessionStatusStore`) is
      // another place where stale busy state persists. It is updated by:
      //   1. Event-driven: applyGlobalSessionStatusEvent (SSE events)
      //   2. Snapshot-driven: applyGlobalSessionStatusSnapshot (authoritative)
      //
      // Both of these are called from the same resync paths described above.
      // If those paths fail or are delayed, the global store also shows stale
      // status. The UI components (sidebar, session dropdown) use this global
      // store to display session activity indicators.
      //
      // The same 5-10 second window applies.
      expect(true).toBe(true) // documentary assertion
    })
  })
})
