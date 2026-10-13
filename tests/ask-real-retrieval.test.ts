import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { LlmStreamEvent, LlmStreamRequest } from "@/lib/ai/llm/types"
import { askOnce, resetAskCountersForTesting, setAskDepsForTesting } from "@/lib/ask/service"
import { resetMemoryThreadStoreForTesting } from "@/lib/ask/thread-store"
import { createInMemoryMeetingDatabase, type InMemoryMeetingDatabase } from "@/lib/meetings/repository"
import { setRateLimitStoreForTesting } from "@/lib/rate-limit"
import { createMemorySearchEngine } from "@/lib/search/memory-engine"
import { setSearchEngineForTesting } from "@/lib/search/service"

import { createTestCtx, testMeeting } from "./helpers/route-ctx"

/**
 * M6 integration: AskMeetSum over the real retrieval stack. Nothing in the
 * search path is faked: `retrievePassages` (Package B) runs on the memory
 * engine, which chunks with Package A's real chunker and normalizer. Only
 * the LLM stream is scripted; it cites the first alias the prompt offered.
 */

const SEGMENTS = [
  { id: "seg_1", speaker: "דנה", startMs: 0, endMs: 4000, text: "בוקר טוב, נתחיל בעדכון על הגיוס." },
  { id: "seg_2", speaker: "רון", startMs: 4000, endMs: 9000, text: "והתקציב לרבעון הבא אושר אתמול בהנהלה." },
  { id: "seg_3", speaker: "דנה", startMs: 9000, endMs: 14000, text: "בתקציב יש חריגה קטנה בשיווק שנטפל בה." },
  { id: "seg_4", speaker: "רון", startMs: 14000, endMs: 18000, text: "בסדר, נקבע פגישת המשך בשבוע הבא." },
]

function seed(): InMemoryMeetingDatabase {
  return createInMemoryMeetingDatabase([
    testMeeting({ id: "m_budget", title: "סקירה רבעונית", transcript: SEGMENTS }),
    testMeeting({
      id: "m_other",
      title: "גיוס",
      transcript: [{ id: "seg_o1", speaker: "דנה", startMs: 0, endMs: 3000, text: "ראיינו שלושה מועמדים השבוע." }],
    }),
    testMeeting({
      id: "m_w2",
      title: "W2",
      workspaceId: "ws_b",
      transcript: [{ id: "seg_w2", speaker: "X", startMs: 0, endMs: 3000, text: "התקציב הסודי של W2 אושר." }],
    }),
  ])
}

/** Scripted LLM: answers with one long cited sentence per offered alias (max two). */
function citingStream() {
  return vi.fn(async function* (req: LlmStreamRequest): AsyncGenerator<LlmStreamEvent> {
    const prompt = req.messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n")
    const aliases = [...new Set([...prompt.matchAll(/\[(s\d+)\b/g)].map((match) => match[1]))].slice(0, 2)
    const text = aliases.map((alias) => `התקציב לרבעון הבא אושר בהנהלה ויש חריגה קטנה בשיווק [${alias}].`).join(" ")

    yield { type: "start", provider: "gemini", model: "gemini-test" }
    yield { type: "delta", text }
    yield {
      type: "done",
      provider: "gemini",
      model: "gemini-test",
      text,
      usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      latencyMs: 1,
      attempts: [],
    }
  })
}

let database: InMemoryMeetingDatabase

beforeEach(() => {
  database = seed()
  resetMemoryThreadStoreForTesting()
  resetAskCountersForTesting()
  setRateLimitStoreForTesting(new Map())
  // Force retrieval even in meeting scope (no full-transcript shortcut).
  process.env.MEETSUM_ASK_FULL_TRANSCRIPT_TOKENS = "1"
  setSearchEngineForTesting(createMemorySearchEngine())
})

afterEach(() => {
  delete process.env.MEETSUM_ASK_FULL_TRANSCRIPT_TOKENS
  setSearchEngineForTesting(undefined)
  setAskDepsForTesting(undefined)
  setRateLimitStoreForTesting(undefined)
})

describe("ask over the real memory search engine (A chunker + normalizer, B retrieve)", () => {
  for (const scope of [{ kind: "workspace" as const }, { kind: "meeting" as const, meetingId: "m_budget" }]) {
    it(`cites real segments in ${scope.kind} scope`, async () => {
      const stream = citingStream()

      // Only the LLM is replaced; retrieve stays the real retrievePassages.
      setAskDepsForTesting({ stream, settings: async () => ({}) })

      const ctx = await createTestCtx({ database, userId: "user_me", workspaceId: "ws_a" })
      const result = await askOnce(ctx, { question: "מה הוחלט לגבי תקציב?", scope, persist: false })

      expect(result.status).toBe("complete")
      expect(result.citations.length).toBeGreaterThan(0)

      const segments = new Map(SEGMENTS.map((segment) => [segment.id, segment]))

      for (const citation of result.citations) {
        expect(citation.meetingId).toBe("m_budget")

        const segment = segments.get(citation.segmentId ?? "")

        expect(segment, citation.segmentId).toBeDefined()
        expect(citation.startMs).toBe(segment!.startMs)
        expect(segment!.text).toContain(citation.quote)
      }

      // The prompt carried transcript text from the real segments, never W2's.
      const prompt = JSON.stringify(stream.mock.calls[0][0].messages)

      expect(prompt).toMatch(/והתקציב לרבעון הבא אושר|בתקציב יש חריגה/)
      expect(prompt).not.toContain("W2")
      expect(prompt).not.toContain("seg_w2")
    })
  }
})
