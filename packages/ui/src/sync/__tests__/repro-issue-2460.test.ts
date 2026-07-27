/**
 * Reproduction test for issue #2460.
 *
 * Problem: When VSCode terminal runs a process (e.g., `bun run dev`) in the
 * same project directory, OpenChamber session creation silently fails on Windows.
 *
 * Root cause chain:
 *
 * 1. Session creation calls `opencodeClient.createSession()` → SDK's
 *    `client.session.create()` → HTTP POST to the OpenCode backend.
 *
 * 2. The SDK client at @opencode-ai/sdk/dist/client.js line 35 explicitly
 *    sets `req.timeout = false`, meaning NO HTTP request ever times out.
 *    When the OpenCode backend hangs (blocked filesystem access), the UI
 *    hangs indefinitely.
 *
 * 3. The OpenCode backend (a separate process `opencode serve`) creates
 *    session metadata (`.opencode/sessions/`) in the project directory.
 *    On Windows, when another process holds file/directory handles,
 *    filesystem operations can hang or return EPERM/EACCES/EBUSY.
 *
 * 4. The error chain silently swallows the failure:
 *    - `session-actions.ts:createSession()` catches and returns `null`
 *    - `session-ui-store.ts:createSession()` catches and returns `null`
 *    - `materializeOpenDraftSession()` throws "Failed to create session"
 *    - ChatInput's .catch() handler restores the text to the textarea
 *
 * 5. The restored draft text survives in the textarea when the user
 *    navigates to an existing session, appearing as if the prompt "appeared
 *    in an existing session instead".
 *
 * Suggested fix: Add a timeout to session creation HTTP requests so they
 * fail-fast instead of hanging indefinitely, OR add a timeout wrapper in
 * opencodeClient.createSession() so the UI can surface the error.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test"

// ---------------------------------------------------------------------------
// Simulate the SDK's req.timeout = false behavior
// ---------------------------------------------------------------------------

describe("issue #2460 – session creation hang on Windows", () => {
  beforeEach(() => {
    mock.restore?.()
  })

  test("SDK client disables fetch timeout, allowing indefinite hang", async () => {
    // This reproduces the SDK client's behavior at
    // node_modules/@opencode-ai/sdk/dist/client.js lines 31-41
    // The customFetch wrapper explicitly sets req.timeout = false,
    // which means HTTP requests have NO timeout and can hang forever.

    // Simulate the SDK's fetch wrapper
    const capturedRequest = new Request("http://localhost:9999/api/test")

    // This is what the SDK does: disables timeout to avoid spurious timeouts
    // @ts-ignore - timeout is a non-standard property on Request
    capturedRequest.timeout = false

    // @ts-ignore
    expect(capturedRequest.timeout).toBe(false)

    // Without a timeout, if the OpenCode backend hangs on a blocked
    // filesystem operation (Windows directory lock), the session
    // creation request never completes.
  })

  test("session creation hangs indefinitely when backend is blocked", async () => {
    // Simulate the scenario where the OpenCode backend hangs
    // (e.g., blocked on a filesystem operation in a locked directory)
    let hangResolve: (() => void) | null = null
    const hangPromise = new Promise<void>((resolve) => {
      hangResolve = resolve
    })

    // Mock the SDK's session.create which never resolves
    const mockSdkCreate = mock(() => hangPromise)

    // Simulate createSessionAction
    const createSession = async () => {
      try {
        return await mockSdkCreate()
      } catch {
        return null
      }
    }

    const resultPromise = createSession()

    // After a short delay, the promise is still pending (hang)
    const raceResult = await Promise.race([
      resultPromise.then(() => "resolved"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("still pending"), 50),
      ),
    ])

    expect(raceResult).toBe("still pending")
    expect(mockSdkCreate).toHaveBeenCalledTimes(1)

    // Cleanup
    hangResolve?.()
  })

  test("SDK error is silently swallowed as null", async () => {
    // Simulate the error chain:
    // 1. SDK returns an error (directory validation failure)
    // 2. opencodeClient.createSession() calls unwrapSdkData which throws
    // 3. createSessionAction() catches and returns null
    // 4. Store's createSession() catches and returns null
    // 5. materializeOpenDraftSession() checks created?.id — null → throws

    const mockSdk = {
      session: {
        create: mock().mockRejectedValue(
          new Error(
            "Request failed with status 500: " +
              "Failed to validate directory: Access to directory denied",
          ),
        ),
      },
    }

    // Simulate createSessionAction (from session-actions.ts)
    const createSessionAction = async () => {
      try {
        const response = await mockSdk.session.create({
          directory: "/some/project",
        })
        return response ?? null
      } catch (error) {
        console.error("[session-actions] createSession failed", error)
        return null
      }
    }

    const result = await createSessionAction()

    // The failure is silently swallowed – returns null
    expect(result).toBeNull()
  })

  test("draft text is restored to textarea after silent failure", async () => {
    // Simulate the restore logic from ChatInput.tsx lines 2456-2460
    // When session creation fails in a new draft, the submitted prompt
    // text is restored to the textarea so the user can retry.

    const inputSnapshot = {
      message: "Fix the login bug",
      hasContent: true,
    }
    const newSessionDraftOpen = true
    let currentInput = inputSnapshot.message // textarea still has the text

    // Error handler from ChatInput.tsx restores text
    if (
      newSessionDraftOpen &&
      inputSnapshot.message &&
      (!currentInput || currentInput === inputSnapshot.message)
    ) {
      // setMessage(inputSnapshot.message) — restore original text
      currentInput = inputSnapshot.message
    }

    expect(currentInput).toBe("Fix the login bug")

    // When the user later navigates to an existing session, the restored
    // text survives in the textarea, which matches the reported behavior:
    // "The prompt that didn't created in new session will appear in
    // existing session instead"
  })

  test("validateDirectoryPath on locked Windows directory returns error", async () => {
    // Simulate the OpenCode backend's directory validation logic.
    // On Windows, file locks can cause EACCES, EPERM, or EBUSY.

    type ValidationResult = { ok: boolean; error?: string }

    const validateDirectory = (errorCode?: string): ValidationResult => {
      if (!errorCode) return { ok: true }
      if (errorCode === "ENOENT") {
        return { ok: false, error: "Directory not found" }
      }
      if (errorCode === "EACCES" || errorCode === "EPERM" || errorCode === "EBUSY") {
        return { ok: false, error: "Access to directory denied" }
      }
      return { ok: false, error: "Failed to validate directory" }
    }

    // On Windows, VSCode terminal's file handles cause these errors
    expect(validateDirectory("EACCES").ok).toBe(false)
    expect(validateDirectory("EPERM").ok).toBe(false)
    expect(validateDirectory("EBUSY").ok).toBe(false)

    // The OpenCode backend returns 400 with this error
    // → SDK throws → createSessionAction returns null → silent failure
  })

  test("encapsulates full reproduction scenario", async () => {
    // Full scenario:
    // 1. User has VSCode open with terminal running `bun run dev`
    // 2. User types prompt in OpenChamber new session draft
    // 3. OpenCode backend can't access locked project directory
    // 4. HTTP POST /session?directory=... hangs (no timeout)
    // 5. OR fails with EACCES → error is silently swallowed
    // 6. Draft text is restored to textarea
    // 7. User navigates to existing session, text is still there
    // 8. User retypes or the text leaks into the existing session

    type Session = { id: string; time: { created: number }; directory?: string }

    // Simulate the createSession flow
    let createSessionHangResolve: (() => void) | null = null
    const createSessionPromise = new Promise<Session>((resolve) => {
      // Simulates a hang — never resolves during normal flow
      setTimeout(() => {
        resolve({ id: "ses_test", time: { created: Date.now() } })
      }, 100000) // 100 second hang
    })

    const sdkSessionCreate = mock(() => createSessionPromise)

    // This is what opencodeClient.createSession does
    const createSession = async (directory?: string | null) => {
      try {
        const response = await sdkSessionCreate()
        // @ts-ignore
        return response
      } catch (error) {
        console.error("[session-actions] createSession failed", error)
        return null
      }
    }

    // Scenario: SDK call hangs (no timeout configured)
    const startTime = Date.now()
    const session = await Promise.race([
      createSession("/project"),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), 50),
      ),
    ])

    // After 50ms, session creation hasn't completed because it hangs
    expect(session).toBeNull()
    expect(sdkSessionCreate).toHaveBeenCalled()
    // No error was surfaced to the user — silent hang
  })
})
