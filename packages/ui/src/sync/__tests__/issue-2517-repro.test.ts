/**
 * Reproduction for issue #2517 (/undo + resend causes duplicate messages).
 *
 * Two scenarios reproduce the bug:
 *
 * 1. SSE session.updated overrides revert marker
 *    After revertToMessage sets revert, a session.updated SSE without the
 *    revert field arrives and clears it. When the user sends, optimisticSend
 *    finds no revert marker → old messages remain → duplicates.
 *
 * 2. Lexicographic ID ordering
 *    The filter `id < revertMessageID` in optimisticSend uses string comparison.
 *    If a message ID (e.g. server-assigned numeric "52") is lexicographically
 *    less than the client's ascendingId format ("msg_<hex><random>"), it
 *    survives the revert cleanup.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test"
import type { Message, OpencodeClient, Part, Session } from "@opencode-ai/sdk/v2/client"

const replyCalls: Array<{ method: string; params: Record<string, unknown> }> = []
let sessionRevertResult: { data?: unknown; error?: unknown; response?: { status?: number } } = {}

const mockSdk = {
  session: {
    messages: mock(() => Promise.resolve({ data: [] })),
    revert: mock(() => Promise.resolve(sessionRevertResult)),
    abort: mock(() => Promise.resolve({ data: true })),
  },
  permission: { reply: mock(() => Promise.resolve({ data: true })) },
  question: { reply: mock(() => Promise.resolve({ data: true })), reject: mock(() => Promise.resolve({ data: true })) },
}

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getScopedSdkClient: () => ({}),
    getDirectory: () => "/test/project",
    getSdkClient: () => mockSdk,
    setDirectory: () => {},
    revertSession: mock((sessionId: string, messageId: string, partId?: string, directory?: string | null) => {
      replyCalls.push({ method: "session.revert", params: { sessionID: sessionId, messageID: messageId, partID: partId, directory } })
      if (sessionRevertResult.error) {
        const status = sessionRevertResult.response?.status
        throw new Error(`session.revert failed${status ? ` (${status})` : ""}: rejected`)
      }
      return Promise.resolve(sessionRevertResult.data)
    }),
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: { getState: () => ({ isConnected: true, hasEverConnected: true }) },
}))

const inputState = { pendingInputText: "", pendingInputMode: "normal" as const, attachedFiles: [] as Array<Record<string, unknown>>, clearAttachedFiles: () => { inputState.attachedFiles = [] }, addRestoredAttachment: (a: Record<string, unknown>) => { inputState.attachedFiles = [...inputState.attachedFiles, a] } }
mock.module("../input-store", () => ({
  useInputStore: { getState: () => inputState, setState: (p: Partial<typeof inputState>) => Object.assign(inputState, p) },
}))

mock.module("@/stores/useGlobalSessionsStore", () => ({
  resolveGlobalSessionDirectory: () => null,
  mergeSessionDirectoryMetadata: (i: Session) => i,
  isGlobalSessionRecencyOnlyUpdate: () => false,
  useGlobalSessionsStore: { getState: () => ({ activeSessions: [], archivedSessions: [], upsertSession: () => {}, removeSessions: () => {} }) },
}))

mock.module("../session-deletion-cleanup", () => ({ cleanupPersistedSessionState: () => {} }))
mock.module("../sync-refs", () => ({
  registerSessionDirectory: () => {},
  emitSyncConfigChanged: () => {},
  getSyncConfig: () => ({}),
  getDirectoryState: () => undefined,
  getSyncSessions: () => [],
  getAllSyncSessions: () => [],
  getAllSyncSessionMap: () => new Map(),
  getSyncMessages: () => [],
  getSyncParts: () => [],
  subscribeToSyncConfigChanges: () => () => {},
  getSyncChildStores: () => { throw new Error("not mocked") },
  setSyncRefs: () => {},
}))

import { create, type StoreApi } from "zustand"
import { INITIAL_STATE } from "../types"
import type { DirectoryStore } from "../child-store"

type OA = { sessionID: string; directory?: string | null; message: Message; parts: Part[] }
type OR = { sessionID: string; directory?: string | null; messageID: string }

function mkStore(s?: Partial<DirectoryStore>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({ ...INITIAL_STATE, ...s, permission: {}, patch: set, replace: set }))
}
function mkChildren(e: Array<[string, StoreApi<DirectoryStore>]>) {
  return { children: new Map(e), ensureChild: (d: string) => new Map(e).get(d) ?? (() => { throw new Error("no store") })(), getChild: (d: string) => new Map(e).get(d) } as unknown as import("../child-store").ChildStoreManager
}

describe("Issue #2517 — /undo + resend duplicate messages", () => {
  beforeEach(() => {
    replyCalls.length = 0
    inputState.pendingInputText = ""
    sessionRevertResult = {}
  })

  test("SCENARIO 1: session.updated SSE overrides revert marker, then send duplicates old messages", async () => {
    const USER_ID = "msg_000001a2b3c40A1B2C3D4E5F6G7H8I"
    const ASST_ID = "msg_000001a2b3c41A1B2C3D4E5F6G7H8I"
    const msgs = [
      { id: USER_ID, role: "user" as const, sessionID: "ses_2517", parentID: "", model: { id: "dv4", providerID: "ds" }, time: { created: 1000 } } as unknown as Message,
      { id: ASST_ID, role: "assistant" as const, sessionID: "ses_2517", parentID: USER_ID, model: { id: "dv4", providerID: "ds" }, time: { created: 2000 } } as unknown as Message,
    ]
    const parts = { [USER_ID]: [{ id: "p1", type: "text" as const, text: "你好" } as Part], [ASST_ID]: [{ id: "p2", type: "text" as const, text: "Hello!" } as Part] }
    const session = { id: "ses_2517", title: "T", version: 1, slug: "t", projectID: "", directory: "/p", model: { id: "dv4", providerID: "ds" }, time: { created: 500, updated: 3000 } } as unknown as Session

    const store = mkStore({ session: [session], message: { ses_2517: msgs }, part: parts })
    const children = mkChildren([["/p", store]])
    const { setActionRefs, revertToMessage, setOptimisticRefs } = await import("../session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, children, () => "/p")

    const removed: string[] = []
    setOptimisticRefs(
      (i: OA) => store.setState((s: DirectoryStore) => ({ message: { ...s.message, [i.sessionID]: [...(s.message[i.sessionID] ?? []), i.message] }, part: { ...s.part, [i.message.id]: i.parts } })),
      (i: OR) => { removed.push(i.messageID); store.setState((s: DirectoryStore) => ({ message: { ...s.message, [i.sessionID]: (s.message[i.sessionID] ?? []).filter((m: Message) => m.id !== i.messageID) }, part: Object.fromEntries(Object.entries(s.part).filter(([k]) => k !== i.messageID)) })) },
      () => {},
    )

    // Revert
    sessionRevertResult = { data: { ...session, time: { created: 500, updated: 3001 }, revert: { messageID: USER_ID } } as unknown as Session }
    await revertToMessage("ses_2517", USER_ID)
    expect(store.getState().session[0].revert?.messageID).toBe(USER_ID)

    // SSE session.updated arrives WITHOUT revert (simulating server echo that drops the field)
    store.setState((s: DirectoryStore) => ({
      session: s.session.map((c: Session) => c.id === "ses_2517" ? { ...session, time: { created: 500, updated: 3002 } } as Session : c)
    }))
    expect(store.getState().session[0].revert).toBe(undefined)

    // Send new message — optimisticSend sees no revert marker
    const { optimisticSend } = await import("../session-actions")
    await optimisticSend({
      sessionId: "ses_2517", directory: "/p", content: "你好 edited", providerID: "ds", modelID: "dv4",
      send: async () => {},
    })

    const finalMsgIds = store.getState().message["ses_2517"].map((m: Message) => m.id)
    console.log("Scenario 1 final messages:", finalMsgIds)
    // BUG: all 3 messages present — old user, old assistant, new user = duplicates
    expect(finalMsgIds.length).toBeGreaterThan(1)
    expect(finalMsgIds).toContain(USER_ID)
    expect(finalMsgIds).toContain(ASST_ID)
  })

  test("SCENARIO 2: server-assigned numeric ID lexicographically < client ID survives revert filter", async () => {
    const USER_ID = "msg_000001a2b3c40A1B2C3D4E5F6G7H8I"
    const ASST_ID = "52"  // Server uses compact numeric IDs — these sort BEFORE "msg_..."
    const msgs = [
      { id: USER_ID, role: "user" as const, sessionID: "ses_2517", parentID: "", model: { id: "dv4", providerID: "ds" }, time: { created: 1000 } } as unknown as Message,
      { id: ASST_ID, role: "assistant" as const, sessionID: "ses_2517", parentID: USER_ID, model: { id: "dv4", providerID: "ds" }, time: { created: 2000 } } as unknown as Message,
    ]
    const parts = { [USER_ID]: [{ id: "p1", type: "text" as const, text: "你好" } as Part], [ASST_ID]: [{ id: "p2", type: "text" as const, text: "Hello!" } as Part] }
    // Session already has revert (post-undo state)
    const session = { id: "ses_2517", title: "T", version: 1, slug: "t", projectID: "", directory: "/p", model: { id: "dv4", providerID: "ds" }, time: { created: 500, updated: 3000 }, revert: { messageID: USER_ID } } as unknown as Session

    const store = mkStore({ session: [session], message: { ses_2517: msgs }, part: parts })
    const children = mkChildren([["/p", store]])
    const { setActionRefs, setOptimisticRefs } = await import("../session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, children, () => "/p")

    setOptimisticRefs(
      (i: OA) => store.setState((s: DirectoryStore) => ({ message: { ...s.message, [i.sessionID]: [...(s.message[i.sessionID] ?? []), i.message] }, part: { ...s.part, [i.message.id]: i.parts } })),
      (i: OR) => store.setState((s: DirectoryStore) => ({ message: { ...s.message, [i.sessionID]: (s.message[i.sessionID] ?? []).filter((m: Message) => m.id !== i.messageID) }, part: Object.fromEntries(Object.entries(s.part).filter(([k]) => k !== i.messageID)) })),
      () => {},
    )

    const { optimisticSend } = await import("../session-actions")
    await optimisticSend({
      sessionId: "ses_2517", directory: "/p", content: "你好 edited", providerID: "ds", modelID: "dv4",
      send: async () => {},
    })

    const finalMsgIds = store.getState().message["ses_2517"].map((m: Message) => m.id)
    console.log("Scenario 2 final messages:", finalMsgIds)
    // BUG: "52" < "msg_..." is TRUE → assistant survives filter → 2 messages (old assistant + new user)
    expect(finalMsgIds).toContain(ASST_ID)  // "52" survives the id < revertMessageID filter!
    expect(finalMsgIds).not.toContain(USER_ID)  // user message removed (has client ID)
  })
})
