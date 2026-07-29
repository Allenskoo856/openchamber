/**
 * Reproduction test for #2516: /undo 撤回并重新发送后消息重复出现两条
 *
 * Root cause:
 * After `/undo` reverts a session, the user edits the message and resends it.
 * `optimisticSend` correctly removes the reverted messages from the local store
 * and clears the revert marker. However, `mergeMessages` (used by `materializeSessionSnapshots`
 * during `refreshTail` / `ensure`) is **additive-only** — it never removes messages
 * that are absent from the server response.
 *
 * When the sync layer subsequently fetches messages from the server (via refreshTail,
 * ensure, or any message materialization), the server still has the original reverted
 * messages. mergeMessages adds them back to the store, and since the revert marker
 * was already cleared by optimisticSend, the reverted messages become visible again —
 * resulting in duplicate user messages.
 */
import { describe, expect, test } from "bun:test"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { mergeMessages } from "../optimistic"
import { materializeSessionSnapshots } from "../materialization"

function userMessage(id: string, text?: string): Message {
  return {
    id,
    sessionID: "ses_1",
    role: "user",
    time: { created: 1 },
  } as Message
}

function assistantMessage(id: string): Message {
  return {
    id,
    sessionID: "ses_1",
    role: "assistant",
    time: { created: 1 },
  } as unknown as Message
}

function textPart(id: string, messageID: string, text: string): Part {
  return { id, messageID, sessionID: "ses_1", type: "text", text } as Part
}

describe("Issue #2516 — /undo + resend duplicates user message", () => {
  test("mergeMessages is additive-only and re-adds messages that optimisticSend removed", () => {
    // ── Simulate state after `/undo` + optimisticSend ──
    //
    // Scenario:
    // 1. User sent msg_1 ("你好"), got assistant response msg_2
    // 2. User did /undo → revert to msg_1 (session.revert = { messageID: "msg_2" })
    //    - msg_2 is hidden from the UI (filtered by session.revert.messageID)
    // 3. User edited and resent → optimisticSend ran:
    //    - Captured reverted messages (msg_2, msg_3 = assistant)
    //    - Cleared session.revert
    //    - Removed msg_2 and msg_3 from store
    //    - Added new message msg_4

    // Current store state AFTER optimisticSend:
    const currentMessages = [
      userMessage("msg_1"),          // original user message (retained)
      // msg_2 was removed by optimisticSend
      // msg_3 was removed by optimisticSend
      userMessage("msg_4"),          // new resend message
    ]
    // No revert marker (cleared by optimisticSend)
    // No parts for removed messages

    // ── Server still has the old messages ──
    // The server-side revert does NOT delete messages — it only sets a
    // session.revert marker on the session. Messages still exist on the server.
    const fetchedFromServer = [
      userMessage("msg_1"),
      userMessage("msg_2"),   // ← still on the server!
      assistantMessage("msg_3"), // ← still on the server!
      userMessage("msg_4"),
    ]

    // ── Now, refreshTail / ensure calls materializeSessionSnapshots ──
    // Inside materializeSessionSnapshots, mergeMessages(current, fetched) is called.
    // mergeMessages is additive-only: for each item in `fetched` that isn't in
    // `current`, it adds it. It NEVER removes messages.
    const merged = mergeMessages(currentMessages, fetchedFromServer)

    // ── BUG: reverted messages come back! ──
    expect(merged.map((m) => m.id)).toEqual([
      "msg_1",
      "msg_2",   // ← BUG: reverted message re-appears!
      "msg_3",   // ← BUG: reverted message re-appears!
      "msg_4",
    ])

    // Since session.revert was cleared by optimisticSend, msg_2 and msg_3
    // are now visible in the UI — causing the duplicate user message (msg_1 vs msg_4)
    // and an extra assistant response (msg_3).
  })

  test("full materialization flow shows reverted messages coming back after resend", () => {
    // ── Previous state (after revert + resend via optimisticSend) ──
    // Store has: msg_1 (retained), msg_4 (new resend), no revert marker
    // Server has: msg_1, msg_2 (old reverted), msg_3 (old reverted), msg_4 (new)
    const currentStoreState = {
      message: {
        ses_1: [
          userMessage("msg_1"),
          userMessage("msg_4"),
        ],
      },
      part: {
        msg_1: [textPart("p_1", "msg_1", "你好")],
        msg_4: [textPart("p_4", "msg_4", "你好（edited）")],
      } as Record<string, Part[]>,
    }

    // Server returns ALL messages (revert does not delete on server)
    const serverRecords = [
      { info: userMessage("msg_1"), parts: [textPart("p_1", "msg_1", "你好")] },
      { info: userMessage("msg_2"), parts: [textPart("p_2", "msg_2", "你好")] },  // old reverted
      { info: assistantMessage("msg_3"), parts: [] },                              // old reverted
      { info: userMessage("msg_4"), parts: [textPart("p_4", "msg_4", "你好（edited）")] },
    ]

    // materializeSessionSnapshots calls mergeMessages internally
    const materialized = materializeSessionSnapshots(
      currentStoreState,
      "ses_1",
      serverRecords,
      { skipPartTypes: new Set(["patch", "step-start", "step-finish"]) },
    )

    const resultMessages = materialized.message.ses_1
    expect(resultMessages.map((m) => m.id)).toEqual([
      "msg_1",
      "msg_2",   // ← BUG: reverted message re-appears!
      "msg_3",   // ← BUG: reverted message re-appears!
      "msg_4",
    ])

    // The store changed (messages were added back)
    expect(materialized.messagesChanged).toBe(true)
  })

  test("mergeMessages reference preservation — reverted messages get fresh references", () => {
    // The additive-only nature means reverted messages get NEW object references
    // when re-added, which can also cause unnecessary React re-renders.

    const current = [userMessage("msg_1"), userMessage("msg_4")]
    const fetched = [userMessage("msg_1"), userMessage("msg_2"), userMessage("msg_4")]

    const msg1ref = current[0]
    const msg4ref = current[1]

    const merged = mergeMessages(current, fetched)

    // msg_1 retained its reference
    expect(merged.find((m) => m.id === "msg_1")).toBe(msg1ref)
    // msg_4 retained its reference
    expect(merged.find((m) => m.id === "msg_4")).toBe(msg4ref)
    // msg_2 is a new reference from the fetched array
    expect(merged.find((m) => m.id === "msg_2")).toBe(fetched[1])
  })
})
