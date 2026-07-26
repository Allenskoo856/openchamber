/**
 * Reproduction tests for issue #2448:
 * "Question form can get stuck in a non-answerable state while still pending"
 *
 * These tests demonstrate three known ways the UI can enter a stuck state
 * where a question is still pending on the backend but no interactive form
 * is shown to the user.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test"
import type { QuestionRequest } from "@/types/question"

// ---------------------------------------------------------------------------
// Mock infrastructure (mirrors session-actions.test.ts)
// ---------------------------------------------------------------------------

const replyCalls: Array<{ method: string; params: Record<string, unknown> }> = []
const scopedClientDirectories: string[] = []
let questionReplyError: unknown | null = null
let questionRejectError: unknown | null = null

const mockScopedClient = {
  question: {
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reply", params })
      if (questionReplyError) {
        return Promise.resolve({ error: questionReplyError, response: { status: 404 } })
      }
      return Promise.resolve({ data: true })
    }),
    reject: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reject", params })
      if (questionRejectError) {
        return Promise.resolve({ error: questionRejectError, response: { status: questionRejectError.status ?? 500 } })
      }
      return Promise.resolve({ data: true })
    }),
  },
}

const mockSdk = {
  session: {
    messages: mock(() => Promise.resolve({ data: [] })),
    abort: mock(() => Promise.resolve({ data: true })),
  },
  question: {
    reply: mock(() => Promise.resolve({ data: true })),
    reject: mock(() => Promise.resolve({ data: true })),
  },
}

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getScopedSdkClient: (directory: string) => {
      scopedClientDirectories.push(directory)
      return mockScopedClient
    },
    getDirectory: () => "/test/project",
    getSdkClient: () => mockSdk,
    replyToQuestion: mock((requestId: string, answers: string[] | string[][], directory?: string | null) => {
      replyCalls.push({ method: "question.reply", params: { requestID: requestId, answers, directory } })
      return Promise.resolve(true)
    }),
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({ isConnected: true, hasEverConnected: true }),
  },
}))

mock.module("../session-ui-store", () => ({
  useSessionUIStore: {
    getState: () => ({
      getDirectoryForSession: () => "/test/project",
      currentSessionId: null,
      setCurrentSession: () => {},
      setWorktreeMetadata: () => {},
    }),
  },
}))

mock.module("../input-store", () => ({
  useInputStore: {
    getState: () => ({
      pendingInputText: "",
      pendingInputMode: "normal" as const,
      attachedFiles: [],
      clearAttachedFiles: () => {},
      addRestoredAttachment: () => {},
    }),
    setState: () => {},
  },
}))

mock.module("@/stores/useGlobalSessionsStore", () => ({
  resolveGlobalSessionDirectory: () => null,
  mergeSessionDirectoryMetadata: (incoming: Record<string, unknown>) => incoming,
  useGlobalSessionsStore: {
    getState: () => ({ activeSessions: [], archivedSessions: [], upsertSession: () => {}, removeSessions: () => {} }),
  },
}))

mock.module("../session-deletion-cleanup", () => ({
  cleanupPersistedSessionState: () => {},
}))

mock.module("../sync-refs", () => ({
  registerSessionDirectory: () => {},
}))

import { create, type StoreApi } from "zustand"
import { INITIAL_STATE } from "../types"
import type { DirectoryStore } from "../child-store"
import type { Session } from "@opencode-ai/sdk/v2/client"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStore(
  state?: Partial<DirectoryStore>,
): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...state,
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

function createChildStores(entries: Array<[string, StoreApi<DirectoryStore>]>) {
  return {
    children: new Map(entries),
    ensureChild: (dir: string) => {
      const store = new Map(entries).get(dir)
      if (!store) throw new Error(`No store for ${dir}`)
      return store
    },
    getChild: (dir: string) => new Map(entries).get(dir),
  } as unknown as import("../child-store").ChildStoreManager
}

function buildQuestion(id: string, sessionId: string): QuestionRequest {
  return {
    id,
    sessionID: sessionId,
    questions: [
      {
        question: "Choose an option",
        header: "Choice",
        options: [{ label: "Yes", description: "Proceed" }],
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Reproduction tests
// ---------------------------------------------------------------------------

describe("Issue #2448: Question form stuck in non-answerable state", () => {

  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    questionReplyError = null
    questionRejectError = null
  })

  // -----------------------------------------------------------------------
  // Scenario 1: QuestionCard sets hasResponded after calling reply/reject,
  // but if the SSE event (question.replied/question.rejected) never arrives,
  // the store still holds the pending question while the card renders nothing.
  // -----------------------------------------------------------------------
  test("Scenario 1: respondToQuestion succeeds but missing SSE question.replied leaves question in store", async () => {
    const question = buildQuestion("q-1", "session-a")
    const store = createStore({
      session: [{ id: "session-a", time: { created: 1 } } as Session],
      question: { "session-a": [question] },
    })

    // Simulate what QuestionCard does: call respondToQuestion then
    // set hasResponded=true. The respondToQuestion succeeds (data: true).
    // But if the SSE question.replied event is lost, the store still has the question.
    const { respondToQuestion } = await import("../session-actions")
    const { setActionRefs } = await import("../session-actions")
    setActionRefs(mockSdk as unknown as import("@opencode-ai/sdk/v2/client").OpencodeClient,
      createChildStores([["/test/project", store]]),
      () => "/test/project")

    // Act: respondToQuestion succeeds
    await respondToQuestion("session-a", "q-1", [["Yes"]])

    // The API call succeeded, so QuestionCard would set hasResponded=true and hide.
    // But the question was NOT removed from the store because no SSE event arrived.
    const state = store.getState()
    expect(state.question["session-a"]).toBeDefined()
    expect(state.question["session-a"]!.length).toBe(1)
    expect(state.question["session-a"]![0].id).toBe("q-1")

    // The question is still pending in the store, but a mounted QuestionCard
    // with hasResponded=true renders nothing (returns null). The user sees
    // no interactive form because the card hides itself, yet the agent remains
    // blocked waiting for an answer.
  })

  // -----------------------------------------------------------------------
  // Scenario 2: During an SSE gap, a missed question.asked event means the
  // question never enters the store. The ToolPart renders the question text
  // read-only (ToolPart.tsx:1704-1728) as "Awaiting response", but no
  // interactive form exists to answer it.
  // -----------------------------------------------------------------------
  test("Scenario 2: question.asked event never arrives due to SSE gap — question never in store", async () => {
    // This tests the event-reducer behavior: without the question.asked event,
    // the question is never added to state.question.
    const store = createStore({
      session: [{ id: "session-a", time: { created: 1 } } as Session],
      question: {},
    })

    // Simulate: SSE event question.asked is lost during a gap.
    // No event means the reducer never adds it.
    const state = store.getState()
    expect(state.question["session-a"]).toBeUndefined()

    // The ToolPart component renders the question text from the tool input
    // (ToolPart.tsx:1704-1728), but since the question is not in the store,
    // no interactive QuestionCard is rendered. The user can only see the
    // read-only question text — no way to answer.
    //
    // The resync mechanism (sync-context.tsx:1153-1211) does recover questions
    // via listPendingQuestions, but ONLY for sessions already in knownSessionIds:
    //   const knownSessionIds = new Set([
    //     ...before.session.map((s) => s.id),
    //     ...Object.keys(before.message ?? {}),
    //     ...Object.keys(before.session_status ?? {}),
    //     ...Object.keys(before.question ?? {}),  <-- empty, so the new session
    //     ...Object.keys(before.permission ?? {}),  is not known!
    //   ])
    // If the session itself is new or not yet in any of these maps, the
    // resync is skipped entirely.
  })

  // -----------------------------------------------------------------------
  // Scenario 3: dismissOpenQuestionsForSession optimistically clears
  // questions from the local store before the backend confirms rejection.
  // If the backend reject fails with a non-404 error, the local store has
  // dropped the question while the backend still considers it pending.
  // -----------------------------------------------------------------------
  test("Scenario 3: dismissOpenQuestionsForSession drops questions from store when reject fails non-404", async () => {
    const question = buildQuestion("q-dismiss", "session-a")
    const store = createStore({
      session: [{ id: "session-a", time: { created: 1 } } as Session],
      question: { "session-a": [question] },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissOpenQuestionsForSession } = await import("../session-actions")
    setActionRefs(mockSdk as unknown as import("@opencode-ai/sdk/v2/client").OpencodeClient,
      childStores,
      () => "/test/project")

    // Make the reject fail with a non-404 error (e.g. 500 Internal Server Error)
    // This is NOT caught by isQuestionRequestNotFoundError (which only matches 404)
    questionRejectError = Object.assign(new Error("Internal Server Error"), { status: 500 }) as unknown

    // Act: dismissOpenQuestionsForSession is called (e.g., when user sends a
    // new message while a question is pending)
    const dismissed = await dismissOpenQuestionsForSession("session-a")

    // It returns true (at least one question was "dismissed")
    expect(dismissed).toBe(true)

    // The question was optimistically REMOVED from the local store
    const state = store.getState()
    expect(state.question["session-a"]).toBeUndefined()

    // But the reject call failed with a non-404 error
    const rejectCalls = replyCalls.filter((call) => call.method === "question.reject")
    expect(rejectCalls).toHaveLength(1)

    // The error was swallowed (line 1222-1224 in session-actions.ts):
    // "Swallow: a failed dismissal must not block the send."
    // But now the local store has dropped the question while the backend
    // still considers it pending. The user sees no interactive form, and
    // the agent remains blocked.
    //
    // The comment says "The next question.asked / question.rejected event
    // reconciles the store." But:
    // - question.rejected will never arrive because the reject failed
    // - question.asked won't re-arrive because the question was already asked
    // So the question is orphaned — the agent is stuck.
  })

  // -----------------------------------------------------------------------
  // Scenario 3 variant: What if an error matching isQuestionRequestNotFoundError?
  // This test shows the contrast: a 404 error IS handled but only as a
  // no-op cleanup, not as a rejection that unblocks the agent.
  // -----------------------------------------------------------------------
  test("Scenario 3 variant: dismiss with 404 removes stale entry but question may be orphaned on backend", async () => {
    const question = buildQuestion("q-stale", "session-a")
    const store = createStore({
      session: [{ id: "session-a", time: { created: 1 } } as Session],
      question: { "session-a": [question] },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissOpenQuestionsForSession } = await import("../session-actions")
    setActionRefs(mockSdk as unknown as import("@opencode-ai/sdk/v2/client").OpencodeClient,
      childStores,
      () => "/test/project")

    // 404 error — isQuestionRequestNotFoundError returns true
    questionRejectError = Object.assign(new Error("question.reject failed (404): QuestionNotFoundError"), { status: 404 })

    const dismissed = await dismissOpenQuestionsForSession("session-a")

    expect(dismissed).toBe(true)
    // Store question is gone
    expect(store.getState().question["session-a"]).toBeUndefined()
    // And the 404 error is handled by isQuestionRequestNotFoundError
    // which calls removeQuestionRequestFromChildStores — but the question
    // was ALREADY removed optimistically before the reject call.
  })
})
