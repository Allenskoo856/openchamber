import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import type { Event, Part } from "@opencode-ai/sdk/v2/client"
import { applyDirectoryEvent } from "../event-reducer"
import { INITIAL_STATE, type State } from "../types"

// ---------------------------------------------------------------------------
// issue #2717 (part 2): after a session interruption the displayed task
// progress stays permanently stuck at the snapshot from before the break.
//
// The chat progress row (components/chat/StatusRow.tsx) renders
// `state.todo[sessionID]`. The sync layer fills that slice ONLY from live
// `todo.updated` events (event-reducer.ts, case "todo.updated"); nothing ever
// re-fetches the authoritative todo list from the server (bootstrap.ts makes
// no `session.todo()` call, and there is no other re-sync path). So once a
// session is interrupted mid-turn, every event of the resumed session —
// message.updated, session.status, message.part.updated — leaves the stale
// todo snapshot untouched until the model happens to emit a new
// `todo.updated`.
// ---------------------------------------------------------------------------

function state(overrides: Partial<State> = {}): State {
  return {
    ...INITIAL_STATE,
    message: {},
    part: {},
    session_status: {},
    ...overrides,
  }
}

const STALE_TODOS = [
  { id: "todo_1", content: "Write tests", status: "completed" as const, priority: "high" as const },
  { id: "todo_2", content: "Fix the bug", status: "in_progress" as const, priority: "high" as const },
  { id: "todo_3", content: "Ship it", status: "pending" as const, priority: "medium" as const },
]

const messageUpdatedForResumedTurn = (): Event =>
  ({
    type: "message.updated",
    properties: {
      info: { id: "msg_2", sessionID: "ses_1", role: "assistant", time: { created: 2 } },
    },
  }) as Event

const sessionStatusBusy = (): Event =>
  ({
    type: "session.status",
    properties: { sessionID: "ses_1", status: { type: "busy" } },
  }) as Event

const partUpdatedForResumedTurn = (): Event =>
  ({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_1",
      part: {
        id: "prt_2",
        messageID: "msg_2",
        sessionID: "ses_1",
        type: "text",
        text: "Continuing the task…",
      } as Part,
    },
  }) as Event

describe("issue #2717 — resumed session keeps the pre-interruption todo snapshot", () => {
  test("message/session/part events of the resumed turn do not refresh the stuck progress", () => {
    // Snapshot of the task list as of the interruption (2 of 3 done, "Fix the
    // bug" still in_progress).
    const draft = state({ todo: { ses_1: [...STALE_TODOS] } })

    // The user "continues": a new assistant message streams in and the session
    // reports busy again.
    applyDirectoryEvent(draft, messageUpdatedForResumedTurn())
    applyDirectoryEvent(draft, sessionStatusBusy())
    applyDirectoryEvent(draft, partUpdatedForResumedTurn())

    // Reproduced: the progress row keeps showing the pre-interruption snapshot.
    expect(draft.todo.ses_1).toEqual(STALE_TODOS)
    expect(draft.todo.ses_1?.[1]?.status).toBe("in_progress")
  })

  test("only a fresh todo.updated event can move the progress forward", () => {
    const draft = state({ todo: { ses_1: [...STALE_TODOS] } })

    applyDirectoryEvent(draft, {
      type: "todo.updated",
      properties: {
        sessionID: "ses_1",
        todos: [
          { id: "todo_1", content: "Write tests", status: "completed" as const, priority: "high" as const },
          { id: "todo_2", content: "Fix the bug", status: "completed" as const, priority: "high" as const },
          { id: "todo_3", content: "Ship it", status: "completed" as const, priority: "medium" as const },
        ],
      },
    } as unknown as Event)

    expect(draft.todo.ses_1?.every((todo) => todo.status === "completed")).toBe(true)
  })

  test("a full reload after the interruption has no server-side todo re-sync to correct it", () => {
    // On reload the sync store starts empty (bootstrap.ts does not fetch
    // `session.todo()`), so the only source left is the localStorage persist
    // snapshot from the last `todo.updated` — the stale one.
    const freshReloadState = state()

    expect(freshReloadState.todo.ses_1).toBe(undefined)

    // A session.updated arriving after the reload carries no todo payload.
    applyDirectoryEvent(freshReloadState, {
      type: "session.updated",
      properties: {
        info: { id: "ses_1", title: "Running task", time: { created: 1, updated: 30 } } as Session,
      },
    } as Event)

    expect(freshReloadState.todo.ses_1).toBe(undefined)
  })
})
