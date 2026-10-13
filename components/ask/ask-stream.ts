/**
 * Ask conversation state and the SSE reader behind `useAskStream`
 * (docs/parity/m6.md, D2). No React here, so it is unit tested in node.
 *
 * "No citation, no claim": provisional deltas are never shown as the answer.
 * On `done` they are replaced by `done.content`; a `complete` answer without
 * a single citation is treated as a refusal, and errors or a stop discard the
 * provisional text.
 */
import type { AskCitation, AskStreamEvent, ThreadMessage } from "@/lib/ask/types"
import { createSseParser } from "@/lib/client/sse"

export type AskTurnStatus = "streaming" | "complete" | "refused" | "error" | "aborted"
export type AskErrorCode = Extract<AskStreamEvent, { type: "error" }>["code"]

export type AskTurn = {
  /** Client id; the assistant message id once the server sends it. */
  id: string
  question: string
  status: AskTurnStatus
  /** Streaming text, shown in the "verifying sources" style only. */
  provisional: string
  content: string
  citations: AskCitation[]
  grounded: boolean
  language?: "he" | "en"
  searchMode?: "hybrid" | "lexical" | "empty"
  messageId?: string | null
  feedback?: -1 | 1 | null
  errorCode?: AskErrorCode
}

export type AskSession = { threadId: string | null; turns: AskTurn[] }

export const EMPTY_ASK_SESSION: AskSession = { threadId: null, turns: [] }

export function startTurn(session: AskSession, id: string, question: string): AskSession {
  return {
    ...session,
    turns: [
      ...session.turns,
      { id, question, status: "streaming", provisional: "", content: "", citations: [], grounded: false },
    ],
  }
}

function updateTurn(session: AskSession, id: string, update: (turn: AskTurn) => AskTurn): AskSession {
  let changed = false
  const turns = session.turns.map((turn) => {
    if (turn.id !== id) return turn
    changed = true

    return update(turn)
  })

  return changed ? { ...session, turns } : session
}

export function applyAskEvent(session: AskSession, turnId: string, event: AskStreamEvent): AskSession {
  switch (event.type) {
    case "thread":
      return updateTurn(
        { ...session, threadId: event.threadId ?? session.threadId },
        turnId,
        (turn) => ({ ...turn, messageId: event.assistantMessageId })
      )
    case "context":
      return updateTurn(session, turnId, (turn) => ({ ...turn, searchMode: event.searchMode }))
    case "delta":
      return updateTurn(session, turnId, (turn) =>
        turn.status === "streaming" ? { ...turn, provisional: turn.provisional + event.text } : turn
      )
    case "done": {
      const citations = Array.isArray(event.citations) ? event.citations : []
      const grounded = event.status === "complete" && event.grounded !== false && citations.length > 0

      return updateTurn(session, turnId, (turn) => ({
        ...turn,
        status: grounded ? "complete" : "refused",
        provisional: "",
        content: grounded ? event.content : "",
        citations: grounded ? citations : [],
        grounded,
        language: event.language,
      }))
    }
    case "error":
      return updateTurn(session, turnId, (turn) => ({
        ...turn,
        status: "error",
        provisional: "",
        errorCode: event.code,
      }))
    default:
      return session
  }
}

/** The user pressed Stop (or the stream ended without `done`). */
export function abortTurn(session: AskSession, turnId: string): AskSession {
  return updateTurn(session, turnId, (turn) =>
    turn.status === "streaming" ? { ...turn, status: "aborted", provisional: "" } : turn
  )
}

/** A stored thread (C6) as turns: each user message with the reply after it. */
export function turnsFromMessages(messages: readonly ThreadMessage[]): AskTurn[] {
  const turns: AskTurn[] = []

  for (const message of messages) {
    if (message.role === "user") {
      turns.push({
        id: message.id,
        question: message.content,
        status: "aborted",
        provisional: "",
        content: "",
        citations: [],
        grounded: false,
      })
      continue
    }

    const turn = turns[turns.length - 1]

    if (!turn || turn.messageId) continue

    const citations = Array.isArray(message.citations) ? message.citations : []
    const status: AskTurnStatus =
      message.status === "complete"
        ? citations.length && message.grounded !== false
          ? "complete"
          : "refused"
        : message.status === "refused" || message.status === "error" || message.status === "aborted"
          ? message.status
          : "aborted"
    const language = message.language === "he" || message.language === "en" ? message.language : undefined

    Object.assign(turn, {
      status,
      content: status === "complete" ? message.content : "",
      citations: status === "complete" ? citations : [],
      grounded: status === "complete",
      messageId: message.id,
      feedback: message.feedback,
      ...(language ? { language } : {}),
    })
  }

  return turns
}

/** Maps a non-OK HTTP response of `POST /api/ask` to an error code. */
export function askErrorCode(status: number, body?: { error?: unknown; code?: unknown }): AskErrorCode {
  const code = typeof body?.code === "string" ? body.code : typeof body?.error === "string" ? body.error : ""

  if (code === "daily_limit") return "daily_limit"
  if (code === "llm_not_configured") return "llm_not_configured"
  if (status === 429 || code === "rate_limited") return "rate_limited"
  if (status === 404 || code === "not_found") return "not_found"
  if (status === 503 || code === "llm_unavailable") return "llm_unavailable"

  return "internal"
}

const EVENT_TYPES = new Set(["thread", "context", "delta", "done", "error"])

function asAskEvent(type: string, data: unknown): AskStreamEvent | undefined {
  if (!data || typeof data !== "object") return undefined

  const event = { ...(data as Record<string, unknown>) }

  if (typeof event.type !== "string") event.type = type
  if (!EVENT_TYPES.has(event.type as string)) return undefined
  if (event.type === "delta" && typeof event.text !== "string") return undefined

  return event as AskStreamEvent
}

/**
 * Reads an SSE response body to the end, calling `onEvent` for every Ask
 * event. Resolves `true` when a terminal event (`done`/`error`) arrived.
 */
export async function readAskStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: AskStreamEvent) => void
): Promise<boolean> {
  let terminal = false
  const parser = createSseParser((type, data) => {
    const event = asAskEvent(type, data)

    if (!event) return
    if (event.type === "done" || event.type === "error") terminal = true
    onEvent(event)
  })
  const reader = body.getReader()
  const decoder = new TextDecoder()

  try {
    for (;;) {
      const { value, done } = await reader.read()

      if (done) break
      parser.push(decoder.decode(value, { stream: true }))
    }
    parser.push(decoder.decode())
    parser.end()
  } finally {
    reader.releaseLock()
  }

  return terminal
}
