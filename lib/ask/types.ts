/**
 * M6 AskMeetSum contracts (docs/parity/m6.md, "Shared contracts"; Step 0).
 * Frozen after Step 0: changes go through the orchestrator.
 */
import type { ChunkKind, SearchScope } from "@/lib/search/types"

export type AskScope = SearchScope

export type AskCitation = {
  n: number
  alias: string
  meetingId: string
  meetingTitle: string
  segmentId?: string
  startMs?: number
  kind: ChunkKind
  speakerName?: string
  quote: string
  unavailable?: boolean
}

export type AskStreamEvent =
  | {
      type: "thread"
      threadId: string | null
      userMessageId: string | null
      assistantMessageId: string | null
    }
  | {
      type: "context"
      mode: "full_transcript" | "retrieval"
      searchMode: "hybrid" | "lexical" | "empty"
      aliases: Record<string, Omit<AskCitation, "n">>
    }
  /** Provisional; the UI replaces it with `done.content`. */
  | { type: "delta"; text: string }
  | {
      type: "done"
      status: "complete" | "refused"
      content: string
      citations: AskCitation[]
      grounded: boolean
      language: "he" | "en"
      droppedUncitedSentences: number
      provider?: string
      model?: string
      usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number }
      costUsd?: number | null
    }
  | {
      type: "error"
      // "llm_not_configured" added additively by the M6 review fixes (no provider set up).
      code: "rate_limited" | "daily_limit" | "llm_unavailable" | "llm_not_configured" | "not_found" | "internal"
      message: string
    }

export type AskRequest = {
  question: string
  scope: AskScope
  threadId?: string
  language?: "he" | "en"
  persist?: boolean
}

export type AskJsonResponse = {
  threadId: string | null
  status: "complete" | "refused" | "error"
  content: string
  citations: AskCitation[]
  grounded: boolean
  language: "he" | "en"
}

export type ThreadSummary = {
  id: string
  scope: AskScope
  title: string | null
  messageCount: number
  lastMessageAt: string | null
  archived: boolean
}

export type ThreadMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  status: string
  citations: AskCitation[]
  grounded: boolean | null
  language: string | null
  feedback: -1 | 1 | null
  createdAt: string
}
