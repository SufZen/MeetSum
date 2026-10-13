/**
 * Request parsing and response mapping shared by the Ask routes
 * (docs/parity/m6.md, C8). Pure: no database, no auth.
 */
import { ASK_QUESTION_MAX_CHARS } from "@/lib/ask/config"
import type { AskOnceResult } from "@/lib/ask/service"
import type { AskCitation, AskRequest, AskScope } from "@/lib/ask/types"
import type { MemoryCitation, MemoryMatchSource } from "@/lib/memory"

const ID_MAX = 200

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function idOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= ID_MAX ? value.trim() : undefined
}

export function parseAskScope(value: unknown): Parsed<AskScope> {
  if (!isRecord(value)) return { ok: false, error: "scope is required" }
  if (value.kind === "workspace") return { ok: true, value: { kind: "workspace" } }
  if (value.kind === "meeting") {
    const meetingId = idOf(value.meetingId)

    return meetingId ? { ok: true, value: { kind: "meeting", meetingId } } : { ok: false, error: "scope.meetingId is required" }
  }
  if (value.kind === "room") {
    const roomId = idOf(value.roomId)

    return roomId ? { ok: true, value: { kind: "room", roomId } } : { ok: false, error: "scope.roomId is required" }
  }
  return { ok: false, error: "scope.kind must be meeting, room or workspace" }
}

/** Question: 1-2000 characters after trimming. */
export function parseQuestion(value: unknown): Parsed<string> {
  const question = typeof value === "string" ? value.trim() : ""

  if (!question) return { ok: false, error: "question is required" }
  if (question.length > ASK_QUESTION_MAX_CHARS) {
    return { ok: false, error: `question must be at most ${ASK_QUESTION_MAX_CHARS} characters` }
  }
  return { ok: true, value: question }
}

export function parseAskRequest(body: unknown): Parsed<AskRequest> {
  if (!isRecord(body)) return { ok: false, error: "A JSON body is required" }

  const question = parseQuestion(body.question)

  if (!question.ok) return question

  const scope = parseAskScope(body.scope)

  if (!scope.ok) return scope
  if (body.threadId !== undefined && !idOf(body.threadId)) return { ok: false, error: "threadId must be a string" }
  if (body.language !== undefined && body.language !== "he" && body.language !== "en") {
    return { ok: false, error: "language must be he or en" }
  }
  if (body.persist !== undefined && typeof body.persist !== "boolean") return { ok: false, error: "persist must be a boolean" }

  return {
    ok: true,
    value: {
      question: question.value,
      scope: scope.value,
      ...(body.threadId !== undefined ? { threadId: idOf(body.threadId)! } : {}),
      ...(body.language !== undefined ? { language: body.language as "he" | "en" } : {}),
      ...(body.persist !== undefined ? { persist: body.persist as boolean } : {}),
    },
  }
}

/** JSON mode when the client asks for JSON and not for an event stream. */
export function wantsJson(request: Request): boolean {
  const accept = request.headers.get("accept") ?? ""

  return /application\/json/i.test(accept) && !/text\/event-stream/i.test(accept)
}

/** HTTP status for an aggregated Ask result. */
export function askResultStatus(result: AskOnceResult): number {
  switch (result.error?.code) {
    case undefined:
      return 200
    case "not_found":
      return 404
    case "daily_limit":
    case "rate_limited":
      return 429
    case "llm_unavailable":
      return 503
    default:
      return 500
  }
}

/** The JSON body for `POST /api/ask` in JSON mode. */
export function askJsonBody(result: AskOnceResult) {
  if (result.error) return { error: result.error.code, message: result.error.message, threadId: result.threadId }

  return {
    threadId: result.threadId,
    status: result.status,
    content: result.content,
    citations: result.citations,
    grounded: result.grounded,
    language: result.language,
  }
}

const SOURCE_BY_KIND: Record<AskCitation["kind"], MemoryMatchSource> = {
  transcript: "transcript",
  summary: "summary",
  item: "decision",
  action_item: "action_item",
  chapter: "summary",
  meta: "summary",
}

/** Legacy `/api/memory/ask` and `/api/rooms/[id]/ask` shape. */
export function legacyMemoryAnswer(result: AskOnceResult): {
  answer: string
  citations: MemoryCitation[]
  status: AskOnceResult["status"]
  grounded: boolean
} {
  return {
    answer: result.content,
    citations: result.citations.map((citation) => ({
      meetingId: citation.meetingId,
      meetingTitle: citation.meetingTitle,
      source: SOURCE_BY_KIND[citation.kind],
      text: citation.quote,
      ...(citation.segmentId ? { segmentId: citation.segmentId } : {}),
      ...(citation.startMs !== undefined ? { startMs: citation.startMs } : {}),
    })),
    status: result.status,
    grounded: result.grounded,
  }
}

/** Legacy `/api/meetings/[id]/ask` shape (`{answer: MeetingAnswer}`). */
export function legacyMeetingAnswer(result: AskOnceResult) {
  return {
    answer: {
      answer: result.content,
      citations: result.citations
        .filter((citation) => citation.segmentId && citation.startMs !== undefined)
        .map((citation) => ({ meetingId: citation.meetingId, segmentId: citation.segmentId!, startMs: citation.startMs! })),
    },
    status: result.status,
    grounded: result.grounded,
  }
}
