import { afterEach, describe, expect, test } from "bun:test"
import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createEventPipeline } from "../event-pipeline"
import {
  clearRuntimeAuthCredentialProvider,
  getRuntimeBearerTokenSync,
  setRuntimeBearerToken,
  subscribeRuntimeUrlAuthToken,
} from "@/lib/runtime-auth"

/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/2631
 *
 * "Credential rotation does not invalidate active sync work"
 *
 * Claim: auth-generation changes (packages/ui/src/lib/runtime-auth.ts:96 —
 * `runtimeAuthGeneration += 1` in `resetRuntimeAuthGeneration`) have no
 * production subscriber that rebinds active sync work. A same-endpoint
 * credential rotation retains transport references, subscriptions, loaders,
 * retries, and stale completions.
 *
 * What the tests show on `main`:
 *  1. The long-lived event stream (SSE/WS transport) is never torn down or
 *     reconnected when credentials rotate on the same endpoint — the pipeline
 *     keeps the connection that was minted with the pre-rotation credential.
 *  2. The only auth-related subscription API exported by runtime-auth
 *     (`subscribeRuntimeUrlAuthToken`) never fires on a credential rotation,
 *     so the sync layer has no observation surface through which it could
 *     rebind even if it wanted to.
 *  3. A manual reconnect after rotation DOES pick up the new credential —
 *     proving the only missing piece is the auth-generation rebind trigger.
 */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Mock SDK that simulates the production SSE path: the Authorization header
 * (bearer token) is captured at connection time (in production it is attached
 * by runtimeFetch / the fetch bridge when the SSE request is issued) and the
 * stream stays open forever — like a server that keeps accepting the
 * rotated-away connection, so no transport failure forces a reconnect.
 */
const createSseSdk = (
  attempts: Array<{ token: string }>,
  onAttempt?: (attempt: number) => void,
): OpencodeClient => ({
  global: {
    event: async ({ signal }: { signal: AbortSignal }) => {
      attempts.push({ token: getRuntimeBearerTokenSync() })
      onAttempt?.(attempts.length)
      return {
        stream: (async function* () {
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve()
              return
            }
            signal.addEventListener("abort", () => resolve(), { once: true })
          })
        })(),
      }
    },
  },
} as unknown as OpencodeClient)

const resolveWhen = (): [Promise<void>, () => void] => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return [promise, resolve]
}

describe("issue-2631 credential rotation does not invalidate active sync work", () => {
  afterEach(() => {
    clearRuntimeAuthCredentialProvider()
  })

  test("same-endpoint credential rotation does not rebind the active event stream", async () => {
    setRuntimeBearerToken("initial-token")

    const attempts: Array<{ token: string }> = []
    const [firstConnection, markFirstConnection] = resolveWhen()
    const sdk = createSseSdk(attempts, (attempt) => {
      if (attempt === 1) markFirstConnection()
    })

    const pipeline = createEventPipeline({
      sdk,
      onEvents: () => undefined,
      transport: "sse",
      heartbeatTimeoutMs: 60_000,
    })

    try {
      await firstConnection
      expect(attempts).toEqual([{ token: "initial-token" }])

      // Same-endpoint credential rotation: this is what switchRuntimeEndpoint
      // does in production when the apiBaseUrl is unchanged but the client
      // token / extra headers change (DesktopHostSwitcher, mobileConnections,
      // SessionAuthGate). It bumps runtimeAuthGeneration and clears the
      // url-token, but nothing in the sync layer is subscribed to it.
      setRuntimeBearerToken("rotated-token")

      // Give any hypothetical rebind subscriber time to tear down and
      // re-establish the transport.
      await wait(300)

      // BUG: the event stream was never rebound. There is still exactly one
      // connection attempt, and it was authenticated with the pre-rotation
      // credential. The transport reference and its subscription are retained
      // across the credential rotation.
      expect(attempts).toEqual([{ token: "initial-token" }])
    } finally {
      pipeline.cleanup()
    }
  })

  test("the only auth subscription API does not fire on credential rotation", async () => {
    setRuntimeBearerToken("initial-token")

    let listenerInvocations = 0
    const unsubscribe = subscribeRuntimeUrlAuthToken(() => {
      listenerInvocations += 1
    })

    try {
      setRuntimeBearerToken("rotated-token")
      await wait(50)

      // BUG: `subscribeRuntimeUrlAuthToken` is the only auth-change
      // subscription exported by runtime-auth, and it only fires on url-token
      // *replacements* (setRuntimeUrlAuthToken swapping an existing token for a
      // fresh one). A credential rotation goes through `resetRuntimeAuthGeneration`
      // -> `clearRuntimeUrlAuthToken`, which never notifies listeners — so no
      // consumer (sync or otherwise) is told that credentials changed.
      expect(listenerInvocations).toBe(0)
    } finally {
      unsubscribe()
    }
  })

  test("a reconnect after rotation picks up the new credential (only the trigger is missing)", async () => {
    setRuntimeBearerToken("initial-token")

    const attempts: Array<{ token: string }> = []
    const [firstConnection, markFirstConnection] = resolveWhen()
    const sdk = createSseSdk(attempts, (attempt) => {
      if (attempt === 1) markFirstConnection()
    })

    const pipeline = createEventPipeline({
      sdk,
      onEvents: () => undefined,
      transport: "sse",
      heartbeatTimeoutMs: 60_000,
    })

    try {
      await firstConnection
      expect(attempts).toEqual([{ token: "initial-token" }])

      setRuntimeBearerToken("rotated-token")

      // The infrastructure would recover correctly IF something triggered a
      // rebind: a fresh connection captures the current bearer token.
      pipeline.reconnect("manual")
      await wait(350)

      expect(attempts.length).toBeGreaterThanOrEqual(2)
      expect(attempts[attempts.length - 1].token).toBe("rotated-token")
    } finally {
      pipeline.cleanup()
    }
  })
})
