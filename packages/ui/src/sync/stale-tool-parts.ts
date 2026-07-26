import type { Part, SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { StoreApi } from "zustand"
import { markDirectorySessionPartChanged, type DirectoryStore } from "./child-store"
import type { State } from "./types"

const FINAL_TOOL_STATUSES = new Set(["completed", "error", "aborted", "failed", "timeout", "cancelled"])

/** Settle orphan running tools once their owning session is already idle. */
const STALE_TOOL_SETTLE_ON_IDLE = true

/**
 * Last-resort wall-clock grace while the session is still busy.
 * Long enough to stay above typical OpenCode tool timeouts (5 min) with margin.
 */
export const STALE_RUNNING_TOOL_WHILE_BUSY_MS = 6 * 60 * 1000

const STALE_TOOL_TIMEOUT_ERROR =
  "OpenCode did not settle this tool after the session went idle or the tool timed out."

type SettledToolRef = {
  sessionID: string
  messageID: string
  partID: string
}

export type StaleToolPartSettlement = {
  nextPart: State["part"]
  settled: SettledToolRef[]
}

const isSessionIdle = (status: SessionStatus | undefined): boolean => (
  !status || status.type === "idle"
)

const readToolStatus = (part: Part): string | undefined => {
  if (part.type !== "tool") return undefined
  const status = (part.state as { status?: unknown } | undefined)?.status
  return typeof status === "string" ? status : undefined
}

const readToolStartMs = (part: Part): number | undefined => {
  if (part.type !== "tool") return undefined
  const start = (part.state as { time?: { start?: unknown } } | undefined)?.time?.start
  return typeof start === "number" ? start : undefined
}

const readToolEndMs = (part: Part): number | undefined => {
  if (part.type !== "tool") return undefined
  const end = (part.state as { time?: { end?: unknown } } | undefined)?.time?.end
  return typeof end === "number" ? end : undefined
}

const readTaskChildSessionId = (part: Part): string | undefined => {
  if (part.type !== "tool" || part.tool?.trim().toLowerCase() !== "task") return undefined
  const metadata = (part.state as { metadata?: unknown } | undefined)?.metadata
  if (!metadata || typeof metadata !== "object") return undefined
  const record = metadata as { sessionId?: unknown; sessionID?: unknown }
  const value = typeof record.sessionId === "string" ? record.sessionId : record.sessionID
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

const hasPendingPermission = (state: State, sessionID: string): boolean => (
  (state.permission[sessionID] ?? []).length > 0
)

const shouldSettleToolPart = (
  state: State,
  part: Part,
  now: number,
  busyGraceMs: number,
): boolean => {
  const status = readToolStatus(part)
  if (!status || FINAL_TOOL_STATUSES.has(status)) return false
  if (status !== "running" && status !== "pending") return false
  if (typeof readToolEndMs(part) === "number") return false

  const sessionID = typeof part.sessionID === "string" ? part.sessionID : ""
  if (!sessionID) return false

  // Pending bash/permission waits are intentional while a permission card is open.
  if (status === "pending" && hasPendingPermission(state, sessionID)) return false

  const sessionStatus = state.session_status[sessionID]
  if (STALE_TOOL_SETTLE_ON_IDLE && isSessionIdle(sessionStatus)) return true

  const childSessionID = readTaskChildSessionId(part)
  if (childSessionID && isSessionIdle(state.session_status[childSessionID])) return true

  const startMs = readToolStartMs(part)
  if (typeof startMs === "number" && now - startMs >= busyGraceMs) return true

  return false
}

const settleToolPart = (part: Part, now: number): Part => {
  if (part.type !== "tool") return part
  const previousState = part.state as {
    input?: Record<string, unknown>
    error?: unknown
    metadata?: Record<string, unknown>
    time?: { start?: number; end?: number }
  }
  const start = typeof previousState.time?.start === "number" ? previousState.time.start : now
  const error = typeof previousState.error === "string" && previousState.error.trim().length > 0
    ? previousState.error
    : STALE_TOOL_TIMEOUT_ERROR

  return {
    ...part,
    state: {
      status: "error",
      input: previousState.input ?? {},
      error,
      ...(previousState.metadata ? { metadata: previousState.metadata } : {}),
      time: {
        start,
        end: now,
      },
    },
  }
}

/**
 * Derive a part-map patch that finalizes orphan running/pending tool parts.
 * Does not invent session.idle — only settles tool part state defensively.
 */
export function settleStaleToolParts(
  state: State,
  now = Date.now(),
  options?: { busyGraceMs?: number },
): StaleToolPartSettlement | null {
  const busyGraceMs = options?.busyGraceMs ?? STALE_RUNNING_TOOL_WHILE_BUSY_MS
  let nextPart: State["part"] | undefined
  const settled: SettledToolRef[] = []

  for (const [messageID, parts] of Object.entries(state.part)) {
    if (!parts || parts.length === 0) continue
    let nextParts: Part[] | undefined

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]
      if (!part || !shouldSettleToolPart(state, part, now, busyGraceMs)) {
        if (nextParts) nextParts.push(part)
        continue
      }

      const settledPart = settleToolPart(part, now)
      if (!nextParts) nextParts = parts.slice(0, index)
      nextParts.push(settledPart)
      settled.push({
        sessionID: typeof part.sessionID === "string" ? part.sessionID : "",
        messageID,
        partID: part.id,
      })
    }

    if (!nextParts) continue
    if (!nextPart) nextPart = { ...state.part }
    nextPart[messageID] = nextParts
  }

  if (!nextPart || settled.length === 0) return null
  return { nextPart, settled }
}

/** Apply defensive settlements into a directory store and annotate part subscribers. */
export function applyStaleToolPartSettlements(
  store: StoreApi<DirectoryStore>,
  now = Date.now(),
  options?: { busyGraceMs?: number },
): number {
  const settlement = settleStaleToolParts(store.getState(), now, options)
  if (!settlement) return 0

  for (const entry of settlement.settled) {
    if (entry.sessionID && entry.messageID) {
      markDirectorySessionPartChanged(store, entry.sessionID, entry.messageID)
    }
  }

  store.setState({ part: settlement.nextPart })
  return settlement.settled.length
}
