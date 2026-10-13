import { describe, expect, it } from "vitest"

import {
  EMPTY_ASK_SESSION,
  abortTurn,
  applyAskEvent,
  askErrorCode,
  readAskStream,
  startTurn,
  turnsFromMessages,
} from "@/components/ask/ask-stream"
import type { AskCitation, AskStreamEvent, ThreadMessage } from "@/lib/ask/types"

const cite: AskCitation = {
  n: 1,
  alias: "s1",
  meetingId: "m1",
  meetingTitle: "ישיבה",
  kind: "transcript",
  quote: "q",
  segmentId: "seg-1",
  startMs: 1000,
}

function done(overrides: Partial<Extract<AskStreamEvent, { type: "done" }>> = {}): AskStreamEvent {
  return {
    type: "done",
    status: "complete",
    content: "התקציב עלה [s1].",
    citations: [cite],
    grounded: true,
    language: "he",
    droppedUncitedSentences: 0,
    ...overrides,
  }
}

describe("ask session state", () => {
  it("streams provisional text, then replaces it with done.content", () => {
    let session = startTurn(EMPTY_ASK_SESSION, "t1", "מה עם התקציב?")

    session = applyAskEvent(session, "t1", { type: "thread", threadId: "th1", userMessageId: "u1", assistantMessageId: "a1" })
    session = applyAskEvent(session, "t1", { type: "context", mode: "retrieval", searchMode: "lexical", aliases: {} })
    session = applyAskEvent(session, "t1", { type: "delta", text: "התקציב " })
    session = applyAskEvent(session, "t1", { type: "delta", text: "עלה" })

    expect(session.threadId).toBe("th1")
    expect(session.turns[0]).toMatchObject({ status: "streaming", provisional: "התקציב עלה", messageId: "a1", searchMode: "lexical" })

    session = applyAskEvent(session, "t1", done())

    expect(session.turns[0]).toMatchObject({
      status: "complete",
      provisional: "",
      content: "התקציב עלה [s1].",
      citations: [cite],
      grounded: true,
      language: "he",
    })
  })

  it("never shows an uncited complete answer: it becomes a refusal", () => {
    let session = startTurn(EMPTY_ASK_SESSION, "t1", "q")

    session = applyAskEvent(session, "t1", { type: "delta", text: "a guess" })
    session = applyAskEvent(session, "t1", done({ citations: [], grounded: false, content: "a guess" }))

    expect(session.turns[0]).toMatchObject({ status: "refused", content: "", citations: [], grounded: false })
  })

  it("keeps a server refusal as refused with no chips", () => {
    const session = applyAskEvent(startTurn(EMPTY_ASK_SESSION, "t1", "q"), "t1", done({ status: "refused", citations: [] }))

    expect(session.turns[0]).toMatchObject({ status: "refused", content: "" })
  })

  it("drops provisional text on error and on stop", () => {
    let session = startTurn(EMPTY_ASK_SESSION, "t1", "q")

    session = applyAskEvent(session, "t1", { type: "delta", text: "partial" })
    expect(abortTurn(session, "t1").turns[0]).toMatchObject({ status: "aborted", provisional: "" })

    session = applyAskEvent(session, "t1", { type: "error", code: "rate_limited", message: "slow down" })
    expect(session.turns[0]).toMatchObject({ status: "error", provisional: "", errorCode: "rate_limited" })
    expect(abortTurn(session, "t1").turns[0].status).toBe("error")
  })

  it("ignores deltas after the turn finished and events for unknown turns", () => {
    let session = applyAskEvent(startTurn(EMPTY_ASK_SESSION, "t1", "q"), "t1", done())

    session = applyAskEvent(session, "t1", { type: "delta", text: "late" })
    expect(session.turns[0].provisional).toBe("")
    expect(applyAskEvent(session, "nope", { type: "delta", text: "x" })).toBe(session)
  })
})

describe("turnsFromMessages", () => {
  const message = (overrides: Partial<ThreadMessage>): ThreadMessage => ({
    id: "x",
    role: "user",
    content: "",
    status: "complete",
    citations: [],
    grounded: null,
    language: null,
    feedback: null,
    createdAt: "2026-10-13T10:00:00Z",
    ...overrides,
  })

  it("pairs questions with replies and keeps statuses", () => {
    const turns = turnsFromMessages([
      message({ id: "u1", content: "שאלה" }),
      message({ id: "a1", role: "assistant", content: "תשובה [s1]", citations: [cite], grounded: true, language: "he", feedback: 1 }),
      message({ id: "u2", content: "unrelated" }),
      message({ id: "a2", role: "assistant", status: "refused", content: "לא מצאתי" }),
      message({ id: "u3", content: "stopped" }),
      message({ id: "a3", role: "assistant", status: "aborted", content: "partial" }),
    ])

    expect(turns.map((turn) => [turn.question, turn.status, turn.content])).toEqual([
      ["שאלה", "complete", "תשובה [s1]"],
      ["unrelated", "refused", ""],
      ["stopped", "aborted", ""],
    ])
    expect(turns[0]).toMatchObject({ messageId: "a1", feedback: 1, language: "he", citations: [cite] })
  })

  it("treats a stored complete answer without citations as refused", () => {
    const turns = turnsFromMessages([
      message({ id: "u1", content: "q" }),
      message({ id: "a1", role: "assistant", content: "guess", citations: [] }),
    ])

    expect(turns[0]).toMatchObject({ status: "refused", content: "" })
  })
})

describe("askErrorCode", () => {
  it("maps HTTP failures", () => {
    expect(askErrorCode(429)).toBe("rate_limited")
    expect(askErrorCode(429, { error: "daily_limit" })).toBe("daily_limit")
    expect(askErrorCode(503, { error: "llm_not_configured" })).toBe("llm_not_configured")
    expect(askErrorCode(404)).toBe("not_found")
    expect(askErrorCode(503)).toBe("llm_unavailable")
    expect(askErrorCode(500)).toBe("internal")
  })
})

describe("readAskStream", () => {
  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()

    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
  }

  it("decodes split UTF-8 and SSE frames into Ask events", async () => {
    const bytes = new TextEncoder().encode('event: delta\ndata: {"type":"delta","text":"שלום"}\n\n')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split inside a Hebrew letter's two UTF-8 bytes.
        controller.enqueue(bytes.slice(0, 44))
        controller.enqueue(bytes.slice(44))
        controller.enqueue(new TextEncoder().encode(`: ping\n\nevent: done\ndata: ${JSON.stringify(done())}\n\n`))
        controller.close()
      },
    })
    const events: AskStreamEvent[] = []

    await expect(readAskStream(body, (event) => events.push(event))).resolves.toBe(true)
    expect(events.map((event) => event.type)).toEqual(["delta", "done"])
    expect(events[0]).toEqual({ type: "delta", text: "שלום" })
  })

  it("reports a stream that ended without a terminal event and skips junk", async () => {
    const events: AskStreamEvent[] = []
    const terminal = await readAskStream(
      streamOf(['event: delta\ndata: {"type":"delta","text":"x"}\n\n', "event: weird\ndata: {}\n\n", "data: not json\n\n"]),
      (event) => events.push(event)
    )

    expect(terminal).toBe(false)
    expect(events).toEqual([{ type: "delta", text: "x" }])
  })
})
