import { describe, expect, test } from "bun:test"
import type { Part, PermissionRequest } from "@opencode-ai/sdk/v2/client"
import { createStore } from "zustand"
import { type DirectoryStore } from "../child-store"
import { applyStaleToolPartSettlements } from "../stale-tool-parts"
import { INITIAL_STATE, type State } from "../types"

function state(overrides: Partial<State> = {}): State {
  return { ...INITIAL_STATE, ...overrides }
}

function runningBash(): Part {
  return {
    id: "prt_bash",
    messageID: "msg_a",
    sessionID: "ses_1",
    type: "tool",
    tool: "bash",
    callID: "call_1",
    state: {
      status: "running",
      time: { start: 1_000 },
      input: { command: "sleep 999" },
      output: "",
    },
  } as Part
}

describe("applyStaleToolPartSettlements", () => {
  test("settles running tools when the session is idle", () => {
    const store = createStore<DirectoryStore>(() => ({
      ...state({
        session_status: { ses_1: { type: "idle" } },
        part: { msg_a: [runningBash()] },
      }),
      patch: () => undefined,
      replace: () => undefined,
    }))

    expect(applyStaleToolPartSettlements(store, 5_000)).toBe(1)
    const part = store.getState().part.msg_a![0]
    expect(part.type).toBe("tool")
    if (part.type !== "tool") return
    expect(part.state.status).toBe("error")
    expect(part.state.status === "error" ? part.state.time.end : undefined).toBe(5_000)
  })

  test("leaves busy sessions and permission waits alone", () => {
    const busy = createStore<DirectoryStore>(() => ({
      ...state({
        session_status: { ses_1: { type: "busy" } },
        part: { msg_a: [runningBash()] },
      }),
      patch: () => undefined,
      replace: () => undefined,
    }))
    expect(applyStaleToolPartSettlements(busy, 5_000)).toBe(0)

    const pending = {
      ...runningBash(),
      state: {
        status: "pending" as const,
        input: { command: "sleep 999" },
        raw: "",
      },
    } as Part
    const waiting = createStore<DirectoryStore>(() => ({
      ...state({
        session_status: { ses_1: { type: "idle" } },
        permission: {
          ses_1: [{
            id: "perm_1",
            sessionID: "ses_1",
            permission: "bash",
            patterns: [],
            metadata: {},
            always: [],
          } as PermissionRequest],
        },
        part: { msg_a: [pending] },
      }),
      patch: () => undefined,
      replace: () => undefined,
    }))
    expect(applyStaleToolPartSettlements(waiting, 5_000)).toBe(0)
  })
})
