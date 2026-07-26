/**
 * Reproduction + recovery tests for issue #2371:
 * UI remains stuck when OpenCode leaves a shell/task tool part running.
 */

import { describe, expect, test } from "bun:test"
import type { Part, PermissionRequest, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { createStore } from "zustand"
import { markDirectorySessionPartChanged, type DirectoryStore } from "../child-store"
import {
  applyStaleToolPartSettlements,
  settleStaleToolParts,
  STALE_RUNNING_TOOL_WHILE_BUSY_MS,
} from "../stale-tool-parts"
import { INITIAL_STATE, type State } from "../types"

function state(overrides: Partial<State> = {}): State {
  return {
    ...INITIAL_STATE,
    session: [],
    sessionTotal: 0,
    session_status: {},
    message: {},
    part: {},
    permission: {},
    question: {},
    ...overrides,
  }
}

function runningBashPart(overrides: Partial<Part> = {}): Part {
  return {
    id: "prt_bash",
    messageID: "msg_assistant",
    sessionID: "ses_1",
    type: "tool",
    tool: "bash",
    callID: "call_bash",
    state: {
      status: "running",
      time: { start: 1_000 },
      input: { command: "sleep 999" },
      output: "",
    },
    ...overrides,
  } as unknown as Part
}

function runningTaskPart(childSessionId?: string): Part {
  return {
    id: "prt_task",
    messageID: "msg_parent",
    sessionID: "ses_parent",
    type: "tool",
    tool: "task",
    callID: "call_task",
    state: {
      status: "running",
      time: { start: 1_000 },
      input: { subagent_type: "code" },
      ...(childSessionId
        ? { metadata: { sessionId: childSessionId } }
        : {}),
    },
  } as unknown as Part
}

function toolStatus(part: Part | undefined): string | undefined {
  if (!part || part.type !== "tool") return undefined
  return part.state.status
}

function toolEnd(part: Part | undefined): number | undefined {
  if (!part || part.type !== "tool") return undefined
  const end = part.state.time && "end" in part.state.time ? part.state.time.end : undefined
  return typeof end === "number" ? end : undefined
}

function toolError(part: Part | undefined): string | undefined {
  if (!part || part.type !== "tool") return undefined
  return part.state.status === "error" ? part.state.error : undefined
}

function pendingBashPart(): Part {
  return {
    id: "prt_bash",
    messageID: "msg_assistant",
    sessionID: "ses_1",
    type: "tool",
    tool: "bash",
    callID: "call_bash",
    state: {
      status: "pending",
      input: { command: "sleep 999" },
      raw: "",
    },
  } as unknown as Part
}

describe("stale tool part recovery (#2371)", () => {
  test("settles running bash tool when session is already idle", () => {
    const draft = state({
      session_status: { ses_1: { type: "idle" } },
      part: { msg_assistant: [runningBashPart()] },
    })

    const settlement = settleStaleToolParts(draft, 5_000)
    expect(settlement).not.toBeNull()
    const part = settlement!.nextPart.msg_assistant![0]
    expect(toolStatus(part)).toBe("error")
    expect(toolEnd(part)).toBe(5_000)
    expect(toolError(part)).toContain("did not settle")
  })

  test("settles parent task tool when child session is idle", () => {
    const draft = state({
      session_status: {
        ses_parent: { type: "busy" } as SessionStatus,
        ses_child: { type: "idle" } as SessionStatus,
      },
      part: { msg_parent: [runningTaskPart("ses_child")] },
    })

    const settlement = settleStaleToolParts(draft, 2_000)
    expect(settlement).not.toBeNull()
    expect(toolStatus(settlement!.nextPart.msg_parent![0])).toBe("error")
  })

  test("does not settle a fresh running tool while session is busy", () => {
    const draft = state({
      session_status: { ses_1: { type: "busy" } },
      part: { msg_assistant: [runningBashPart()] },
    })

    expect(settleStaleToolParts(draft, 1_000 + 60_000)).toBeNull()
  })

  test("settles wall-clock stale tools while session remains busy", () => {
    const draft = state({
      session_status: { ses_1: { type: "busy" } },
      part: { msg_assistant: [runningBashPart()] },
    })

    const settlement = settleStaleToolParts(
      draft,
      1_000 + STALE_RUNNING_TOOL_WHILE_BUSY_MS,
    )
    expect(settlement).not.toBeNull()
    expect(toolStatus(settlement!.nextPart.msg_assistant![0])).toBe("error")
  })

  test("does not settle pending tools that still have a permission request", () => {
    const draft = state({
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
      part: { msg_assistant: [pendingBashPart()] },
    })

    expect(settleStaleToolParts(draft, 10_000)).toBeNull()
  })

  test("applyStaleToolPartSettlements patches the directory store", () => {
    const store = createStore<DirectoryStore>(() => ({
      ...state({
        session_status: { ses_1: { type: "idle" } },
        part: { msg_assistant: [runningBashPart()] },
      }),
      patch: () => undefined,
      replace: () => undefined,
    }))

    const settled = applyStaleToolPartSettlements(store, 9_000)
    expect(settled).toBe(1)
    expect(toolStatus(store.getState().part.msg_assistant![0])).toBe("error")
  })

  test("markDirectorySessionPartChanged remains callable for settled refs", () => {
    const store = createStore<DirectoryStore>(() => ({
      ...state({
        session_status: { ses_1: { type: "idle" } },
        part: { msg_assistant: [runningBashPart()] },
      }),
      patch: () => undefined,
      replace: () => undefined,
    }))
    markDirectorySessionPartChanged(store, "ses_1", "msg_assistant")
    expect(applyStaleToolPartSettlements(store, 9_000)).toBe(1)
  })
})
