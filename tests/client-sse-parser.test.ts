import { describe, expect, it } from "vitest"

import { createSseParser } from "@/lib/client/sse"

function collect() {
  const events: Array<{ type: string; data: unknown }> = []
  const parser = createSseParser((type, data) => events.push({ type, data }))

  return { events, parser }
}

describe("createSseParser", () => {
  it("parses whole frames with an event type and JSON data", () => {
    const { events, parser } = collect()

    parser.push('event: delta\ndata: {"type":"delta","text":"שלום"}\n\n')

    expect(events).toEqual([{ type: "delta", data: { type: "delta", text: "שלום" } }])
  })

  it("buffers frames split across chunks, even mid-codepoint text and mid-line", () => {
    const { events, parser } = collect()
    const frame = 'event: done\ndata: {"type":"done","content":"תקציב [s1]"}\n\n'

    for (const char of frame) parser.push(char)

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ type: "done", data: { type: "done", content: "תקציב [s1]" } })
  })

  it("accepts CRLF and CR line endings", () => {
    const { events, parser } = collect()

    parser.push('event: a\r\ndata: {"n":1}\r\n\r\nevent: b\rdata: {"n":2}\r\r')

    expect(events).toEqual([
      { type: "a", data: { n: 1 } },
      { type: "b", data: { n: 2 } },
    ])
  })

  it("handles a CRLF split between two chunks", () => {
    const { events, parser } = collect()

    parser.push('event: a\r\ndata: {"n":1}\r')
    parser.push("\n\r\n")

    expect(events).toEqual([{ type: "a", data: { n: 1 } }])
  })

  it("joins multi-line data with newlines", () => {
    const { events, parser } = collect()

    parser.push("event: note\ndata: line one\ndata: line two\n\n")

    expect(events).toEqual([{ type: "note", data: "line one\nline two" }])
  })

  it("defaults the type to message, then to the data's own type field", () => {
    const { events, parser } = collect()

    parser.push("data: plain\n\n")
    parser.push('data: {"type":"context","mode":"retrieval"}\n\n')

    expect(events).toEqual([
      { type: "message", data: "plain" },
      { type: "context", data: { type: "context", mode: "retrieval" } },
    ])
  })

  it("ignores comments (keep-alives), ids, retry and frames without data", () => {
    const { events, parser } = collect()

    parser.push(": keep-alive\n\nid: 7\nretry: 1000\n\nevent: empty\n\n")

    expect(events).toEqual([])
  })

  it("strips exactly one leading space after the colon", () => {
    const { events, parser } = collect()

    parser.push("data:no-space\n\ndata:  two-spaces\n\n")

    expect(events).toEqual([
      { type: "message", data: "no-space" },
      { type: "message", data: " two-spaces" },
    ])
  })

  it("flushes an unterminated final frame on end()", () => {
    const { events, parser } = collect()

    parser.push('event: done\ndata: {"ok":true}')
    expect(events).toEqual([])
    parser.end()

    expect(events).toEqual([{ type: "done", data: { ok: true } }])
  })

  it("ignores pushes after end()", () => {
    const { events, parser } = collect()

    parser.end()
    parser.push("data: late\n\n")

    expect(events).toEqual([])
  })

  it("strips a leading byte-order mark", () => {
    const { events, parser } = collect()

    parser.push('﻿data: {"a":1}\n\n')

    expect(events).toEqual([{ type: "message", data: { a: 1 } }])
  })
})
