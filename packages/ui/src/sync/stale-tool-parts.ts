import type { Part } from "@opencode-ai/sdk/v2/client"
import type { StoreApi } from "zustand"
import { markDirectorySessionPartChanged, type DirectoryStore } from "./child-store"
import type { State } from "./types"

/**
 * Finalize tool parts left `running`/`pending` after their session is idle.
 * OpenCode sometimes misses the final message.part.updated; without this the
 * UI waits forever. Does not invent session.idle.
 */
export function applyStaleToolPartSettlements(
  store: StoreApi<DirectoryStore>,
  now = Date.now(),
): number {
  const state = store.getState()
  let nextPart: State["part"] | undefined
  let settled = 0

  for (const [messageID, parts] of Object.entries(state.part)) {
    if (!parts?.length) continue
    let nextParts: Part[] | undefined

    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]
      if (!part || part.type !== "tool") {
        if (nextParts) nextParts.push(part)
        continue
      }

      const { status } = part.state
      if (status !== "running" && status !== "pending") {
        if (nextParts) nextParts.push(part)
        continue
      }

      const time = "time" in part.state ? part.state.time : undefined
      const hasEnd = Boolean(time && "end" in time && typeof time.end === "number")
      const sessionID = part.sessionID
      const sessionStatus = state.session_status[sessionID]
      const idle = !sessionStatus || sessionStatus.type === "idle"
      const waitingPermission = status === "pending" && (state.permission[sessionID] ?? []).length > 0

      if (hasEnd || !idle || waitingPermission) {
        if (nextParts) nextParts.push(part)
        continue
      }

      const start = time && typeof time.start === "number" ? time.start : now
      const settledPart: Part = {
        ...part,
        state: {
          status: "error",
          input: part.state.input,
          error: "OpenCode did not settle this tool after the session went idle.",
          ...("metadata" in part.state && part.state.metadata ? { metadata: part.state.metadata } : {}),
          time: { start, end: now },
        },
      }
      if (!nextParts) nextParts = parts.slice(0, i)
      nextParts.push(settledPart)
      markDirectorySessionPartChanged(store, sessionID, messageID)
      settled += 1
    }

    if (!nextParts) continue
    if (!nextPart) nextPart = { ...state.part }
    nextPart[messageID] = nextParts
  }

  if (!nextPart || settled === 0) return 0
  store.setState({ part: nextPart })
  return settled
}
