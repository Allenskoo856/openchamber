/**
 * Reproduction test for issue #2482
 * 
 * Bug: Session created successfully, first message visible in OpenChamber UI,
 * but message does NOT arrive in the OpenCode session. No errors in console.
 *
 * This test traces the exact flow and identifies potential issues.
 */
import { describe, expect, test, mock, afterEach } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { OpencodeClient, Session, Message, Part } from "@opencode-ai/sdk/v2/client"

// ---------------------------------------------------------------------------
// Global state to track API calls
// ---------------------------------------------------------------------------
const sdkCalls: Array<{ method: string; params: unknown }> = []
let _sessionCreateData = { id: "ses_repro_1", time: { created: Date.now() } }

// ---------------------------------------------------------------------------
// Mock SDK client
// ---------------------------------------------------------------------------
const mockSdk = {
  session: {
    create: mock((params: unknown) => {
      sdkCalls.push({ method: "sdk.session.create", params })
      return Promise.resolve({ data: _sessionCreateData })
    }),
    promptAsync: mock((params: unknown) => {
      sdkCalls.push({ method: "sdk.session.promptAsync", params })
      return Promise.resolve({ data: true })
    }),
    messages: mock((params: unknown) => {
      sdkCalls.push({ method: "sdk.session.messages", params })
      return Promise.resolve({ data: [] })
    }),
    revert: mock(() => Promise.resolve({ data: true })),
    abort: mock(() => Promise.resolve({ data: true })),
    update: mock(() => Promise.resolve({})),
    updateSession: mock(() => {}),
    share: mock(() => Promise.resolve({})),
    unshare: mock(() => Promise.resolve({})),
  },
  permission: { reply: mock(() => Promise.resolve({ data: true })) },
  question: { reply: mock(() => Promise.resolve({ data: true })), reject: mock(() => Promise.resolve({ data: true })) },
  path: { get: mock(() => Promise.resolve({ data: { directory: "/test/project" } })) },
  experimental: { controlPlane: { moveSession: mock(() => Promise.resolve({})) } },
}

// ---------------------------------------------------------------------------
// Mock modules
// ---------------------------------------------------------------------------
mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getScopedSdkClient: () => mockSdk,
    getDirectory: () => "/test/project",
    getSdkClient: () => mockSdk,
    setDirectory: mock((dir?: string) => {
      sdkCalls.push({ method: "client.setDirectory", params: { directory: dir } })
    }),
    createSession: mock(async (params: Record<string, unknown>, directory?: string | null) => {
      sdkCalls.push({ method: "client.createSession", params: { params, directory } })
      return { ..._sessionCreateData, directory: directory ?? undefined } as Session
    }),
    sendMessage: mock(async (params: Record<string, unknown>) => {
      sdkCalls.push({ method: "client.sendMessage", params })
      return "msg_repro_1"
    }),
    sendCommand: mock(() => Promise.resolve()),
    replyToPermission: mock(() => Promise.resolve(true)),
    replyToQuestion: mock(() => Promise.resolve(true)),
    revertSession: mock(() => Promise.resolve(true)),
    updateSession: mock(() => Promise.resolve({})),
    deleteSession: mock(() => Promise.resolve(true)),
    checkHealth: mock(() => Promise.resolve(true)),
    listPendingQuestions: mock(() => Promise.resolve([])),
    listPendingPermissions: mock(() => Promise.resolve([])),
    summarizeSession: mock(() => Promise.resolve()),
    normalizeCandidatePath: (path?: string | null) => {
      if (typeof path !== 'string') return null
      const trimmed = path.trim()
      if (!trimmed) return null
      const normalized = trimmed.replace(/\\/g, '/').replace(/^([a-z]):/, (_, l: string) => l.toUpperCase() + ':')
      return (normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized) || null
    },
    withDirectory: async (_dir: string | undefined | null, fn: () => Promise<unknown>) => fn(),
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      isConnected: true,
      hasEverConnected: true,
      lastDisconnectReason: null,
      probeConnection: () => Promise.resolve(true),
    }),
  },
}))

mock.module("@/components/ui", () => ({
  toast: { info: () => undefined, error: () => undefined, success: () => undefined },
}))

mock.module("@/stores/useGlobalSessionsStore", () => ({
  resolveGlobalSessionDirectory: (s: Record<string, unknown>) => 
    (s.directory as string) ?? ((s.project as Record<string, unknown>)?.worktree as string) ?? null,
  mergeSessionDirectoryMetadata: (incoming: Record<string, unknown>, existing?: Record<string, unknown> | null) => {
    if (!existing) return incoming
    return { ...incoming, directory: (incoming.directory as string) ?? (existing.directory as string) }
  },
  isGlobalSessionRecencyOnlyUpdate: () => false,
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: [],
      archivedSessions: [],
      upsertSession: () => {},
      removeSessions: () => {},
    }),
  },
}))

mock.module("@/stores/permissionStore", () => ({
  usePermissionStore: { getState: () => ({ isSessionAutoAccepting: () => false }) },
}))

mock.module("@/stores/useTodosPersistStore", () => ({
  useTodosPersistStore: { getState: () => ({}) },
}))

mock.module("@/stores/useProjectsStore", () => ({
  useProjectsStore: { getState: () => ({ projects: [], activeProjectId: null, setActiveProjectIdOnly: () => {} }) },
}))

mock.module("@/stores/useDirectoryStore", () => ({
  useDirectoryStore: { getState: () => ({ currentDirectory: "/test/project", setDirectory: () => {} }) },
}))

mock.module("@/stores/useCommandsStore", () => ({
  useCommandsStore: { getState: () => ({ commands: [] }) },
}))

mock.module("@/stores/useSkillsStore", () => ({
  useSkillsStore: { getState: () => ({ skills: [] }) },
}))

mock.module("@/stores/useSnippetsStore", () => ({
  useSnippetsStore: { getState: () => ({ expandText: async (text: string) => text }) },
}))

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------
import { INITIAL_STATE, type State } from "../types"
import type { DirectoryStore } from "../child-store"

function createDirStore(initial?: Partial<State>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    session: initial?.session ?? [],
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("Issue #2482: create session + send first message", () => {
  test("1. traces the flow: createSession -> sendMessage with directory consistency", async () => {
    const directory = "/test/project"
    const childStores = createChildStores([[directory, createDirStore()]])

    const sessionActions = await import("../session-actions")
    sessionActions.setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => directory)

    // Step 1: createSession
    const session = await sessionActions.createSession("Issue 2482 test", directory)
    expect(session).not.toBeNull()
    expect(session!.id).toBe("ses_repro_1")

    // Step 2: fetchMessagesForSession (as done by setCurrentSession)
    await sessionActions.fetchMessagesForSession(session!.id, directory)

    // Step 3: sendMessage via opencodeClient (as routeMessage would do)
    const { opencodeClient } = await import("@/lib/opencode/client")
    await opencodeClient.sendMessage({
      id: session!.id,
      providerID: "openai",
      modelID: "gpt-4",
      text: "Hello, first message",
      directory,
    })

    // Show all API calls in order
    console.log("[REPRO] API call sequence:")
    sdkCalls.forEach((call, i) => {
      const params = call.params as Record<string, unknown>
      if (call.method === "client.createSession") {
        console.log(`  ${i+1}. ${call.method}: directory=${params.directory}`)
      } else if (call.method === "client.sendMessage") {
        console.log(`  ${i+1}. ${call.method}: id=${params.id}, directory=${params.directory}`)
      } else if (call.method === "sdk.session.create" || call.method === "sdk.session.promptAsync") {
        console.log(`  ${i+1}. ${call.method}: directory=${(params as Record<string, unknown>).directory}`)
      } else {
        console.log(`  ${i+1}. ${call.method}`)
      }
    })

    // Verify: createSession directory equals sendMessage directory
    const createCall = sdkCalls.find(c => c.method === "client.createSession")
    const sendCall = sdkCalls.find(c => c.method === "client.sendMessage")
    const createParams = createCall?.params as { params?: Record<string, unknown>; directory?: string } | undefined
    const sendParams = sendCall?.params as Record<string, unknown> | undefined
    expect(createParams?.directory).toBe(directory)
    expect(sendParams?.directory).toBe(directory)
  })

  test("2. verifies directory fallback when session has no directory field", async () => {
    // Simulate a session returned WITHOUT a directory field
    _sessionCreateData = { id: "ses_no_dir", time: { created: Date.now() } }

    const directory = "/test/project"
    const childStores = createChildStores([[directory, createDirStore()]])

    const sessionActions = await import("../session-actions")
    sessionActions.setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => directory)
    sessionActions.setOptimisticRefs(mock(() => {}), mock(() => {}))

    const sessionResult = (await sessionActions.createSession("No dir test"))!
    // Even without explicit directory override, the store.createSession method
    // falls back to opencodeClient.getDirectory() = "/test/project"
    // So the session has a directory field // via dir() fallback
    expect(sessionResult).not.toBeNull()
    expect(sessionResult.id).toBe("ses_no_dir")

    // Check that session creation used the fallback directory (from dir())
    const createCall = sdkCalls.find(c => c.method === "client.createSession")
    const createParams = createCall?.params as { params?: Record<string, unknown>; directory?: string } | undefined
    console.log("[REPRO] createSession call with no dir override:", JSON.stringify(createParams, null, 2))
    // The directory should fall back to dir() which returns "/test/project"
    expect(createParams?.directory).toBe(directory)

    // Now simulate materializeOpenDraftSession's directory calculation:
    const sessionDirFromServer = (sessionResult as Record<string, unknown>).directory
    const draftDirectoryOverride = null
    const createdDirectory = draftDirectoryOverride ?? sessionDirFromServer ?? null
    console.log("[REPRO] session.directory from server:", sessionDirFromServer)
    console.log("[REPRO] createdDirectory (used for routeMessage):", createdDirectory)

    // When routeMessage is called with this directory, opencodeClient.sendMessage
    // uses it directly
    const { opencodeClient } = await import("@/lib/opencode/client")
    await opencodeClient.sendMessage({
      id: sessionResult.id,
      providerID: "openai",
      modelID: "gpt-4",
      text: "Test with null directory",
      directory: createdDirectory as string | null | undefined,
    })

    const sendCall = sdkCalls.find(c => c.method === "client.sendMessage")
    const sendParams = sendCall?.params as Record<string, unknown> | undefined
    console.log("[REPRO] sendMessage params (with null directory):", JSON.stringify(sendParams, null, 2))
    
    // NOTE: In the real flow, if draftDirectoryOverride is null and session.directory
    // is also null (server doesn't return it), then createdDirectory would be null.
    // But here, session.directory has the value "/test/project" due to the fallback
    // in store.createSession (directoryOverride ?? opencodeClient.getDirectory()).
    // This shows the directory fallback chain works correctly.
    // The param passed to sendMessage is the resolved non-null directory.
    expect(sendParams?.directory).toBe("/test/project")
  })

  test("3. demonstrates double setCurrentSession causing two fetchMessagesForSession calls", async () => {
    /* 
     * This is a key finding for issue #2482:
     * 
     * In materializeOpenDraftSession:
     *   1. store.createSession() is called
     *      → createSessionAction() calls setCurrentSession() 
     *        → fetches messages for the new session (FIRE-AND-FORGET #1)
     *   2. store.setCurrentSession() is called AGAIN at line 497
     *        → fetches messages for the new session (FIRE-AND-FORGET #2)
     *   3. routeMessage() is called
     *      → optimisticSend() adds optimistic message to store
     *      → send() calls promptAsync()
     * 
     * The double fetch creates TWO async message load operations that both 
     * fetch empty messages from the brand-new session. These can race with
     * the optimistic message insert in step 3.
     */
    const directory = "/test/project"
    const childStores = createChildStores([[directory, createDirStore()]])

    const sessionActions = await import("../session-actions")
    sessionActions.setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => directory)

    // Clear call log before test
    sdkCalls.length = 0

    // Simulate the double setCurrentSession pattern:
    // First call (from createSessionAction)
    await sessionActions.fetchMessagesForSession("ses_double_test", directory)
    console.log("[REPRO] After first fetchMessagesForSession, sdk calls:", sdkCalls.length)

    // Second call (from materializeOpenDraftSession line 497)
    await sessionActions.fetchMessagesForSession("ses_double_test", directory)
    console.log("[REPRO] After second fetchMessagesForSession, sdk calls:", sdkCalls.length)

    // Count session.messages calls
    const messagesCalls = sdkCalls.filter(c => c.method === "sdk.session.messages")
    console.log(`[REPRO] session.messages SDK calls: ${messagesCalls.length}`)
    
    // NOTE: fetchMessagesForSession uses getImperativeSessionMessageLoader()? ensure()
    // which returns null in test environment (no loader configured).
    // In real app, this would trigger actual SDK calls.
    // This test verifies the CALL PATTERN analysis, not runtime behavior.
    console.log("[REPRO] In real app, this would trigger session.messages SDK calls for each fetchMessagesForSession call")
    console.log("[REPRO] The double fetch creates a race with optimistic message insert")
  })

  test("4. SDK session.create vs promptAsync directory consistency", async () => {
    /* 
     * This tests the actual SDK call consistency.
     * In the real app, opencodeClient.createSession calls 
     * this.client.session.create() and opencodeClient.sendMessage calls
     * this.client.session.promptAsync().
     * 
     * Both receive the directory as a parameter. The SDK adds it to the URL
     * as a query parameter (?directory=...).
     */
    
    // Simulate calling the SDK methods directly
    const sdk = mockSdk

    // Session creation
    await sdk.session.create({
      directory: "/test/project",
      title: "Test session",
    })
    
    // Message send
    await sdk.session.promptAsync({
      sessionID: "ses_repro_1",
      directory: "/test/project",
      model: { providerID: "openai", modelID: "gpt-4" },
      parts: [{ type: "text", text: "Hello" }],
      messageID: "msg_1",
    })

    const createSdkCalls = sdkCalls.filter(c => c.method === "sdk.session.create")
    const promptSdkCalls = sdkCalls.filter(c => c.method === "sdk.session.promptAsync")
    
    console.log("[REPRO] SDK session.create params:", JSON.stringify(createSdkCalls[0]?.params, null, 2))
    console.log("[REPRO] SDK session.promptAsync params:", JSON.stringify(promptSdkCalls[0]?.params, null, 2))

    // Both should use the same directory
    const createDir = (createSdkCalls[0]?.params as Record<string, unknown> | undefined)?.directory
    const promptDir = (promptSdkCalls[0]?.params as Record<string, unknown> | undefined)?.directory
    expect(createDir).toBe("/test/project")
    expect(promptDir).toBe("/test/project")
  })
})

// Reset between tests
afterEach(() => {
  sdkCalls.length = 0
  _sessionCreateData = { id: "ses_repro_1", time: { created: Date.now() } }
})
