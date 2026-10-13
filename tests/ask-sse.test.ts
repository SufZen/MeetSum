import { afterEach, describe, expect, it, vi } from "vitest"

import { sseResponse } from "@/lib/http/sse"

/** SSE framing (docs/parity/m6.md, C8). */

async function readAll(response: Response): Promise<string> {
  return await response.text()
}

function frames(text: string): Array<{ event: string; data: unknown }> {
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("event:"))
    .map((block) => {
      const [eventLine, dataLine] = block.split("\n")

      return { event: eventLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) }
    })
}

afterEach(() => {
  vi.useRealTimers()
})

describe("sseResponse", () => {
  it("frames every event as event/data with the SSE headers", async () => {
    async function* events() {
      yield { type: "thread", threadId: "t1" }
      yield { type: "delta", text: "שלום\nעולם" }
      yield { type: "done", content: "x" }
    }

    const response = sseResponse(events(), {})

    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform")
    expect(response.headers.get("x-accel-buffering")).toBe("no")

    const text = await readAll(response)

    expect(text).toContain('event: delta\ndata: {"type":"delta","text":"שלום\\nעולם"}\n\n')
    expect(frames(text).map((frame) => frame.event)).toEqual(["thread", "delta", "done"])
  })

  it("keeps extra headers (rate-limit) without letting them override the content type", () => {
    async function* events() {
      yield { type: "done" }
    }

    const response = sseResponse(events(), {
      headers: { "X-RateLimit-Remaining": "3", "Content-Type": "application/json" },
    })

    expect(response.headers.get("x-ratelimit-remaining")).toBe("3")
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
  })

  it("sends a keep-alive comment while the producer is quiet", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    async function* events() {
      await gate
      yield { type: "done" }
    }

    const response = sseResponse(events(), { keepAliveMs: 5 })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const first = await reader.read()

    expect(decoder.decode(first.value)).toBe(": keep-alive\n\n")
    release()

    let rest = ""

    for (;;) {
      const chunk = await reader.read()

      if (chunk.done) break
      rest += decoder.decode(chunk.value)
    }
    expect(rest).toContain("event: done")
  })

  it("turns a producer failure into a generic error event without the message", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    async function* events() {
      yield { type: "delta", text: "a" }
      throw new Error("secret passage text from the transcript")
    }

    const text = await readAll(sseResponse(events(), {}))
    const last = frames(text).at(-1)

    expect(last?.event).toBe("error")
    expect(last?.data).toEqual({ type: "error", code: "internal", message: "Internal error" })
    expect(text).not.toContain("secret passage")
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain("secret passage")
    consoleSpy.mockRestore()
  })

  it("stops reading and closes the producer when the request aborts", async () => {
    const controller = new AbortController()
    let finalized = false

    async function* events() {
      try {
        yield { type: "delta", text: "1" }
        controller.abort()
        yield { type: "delta", text: "2" }
        yield { type: "delta", text: "3" }
      } finally {
        finalized = true
      }
    }

    const text = await readAll(sseResponse(events(), { signal: controller.signal }))

    expect(frames(text).map((frame) => (frame.data as { text: string }).text)).toEqual(["1"])
    expect(finalized).toBe(true)
  })

  it("closes the producer when the client cancels the body", async () => {
    let finalized = false

    async function* events() {
      try {
        for (let index = 0; ; index += 1) {
          yield { type: "delta", text: String(index) }
          await new Promise((resolve) => setTimeout(resolve, 1))
        }
      } finally {
        finalized = true
      }
    }

    const reader = sseResponse(events(), {}).body!.getReader()

    await reader.read()
    await reader.cancel()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(finalized).toBe(true)
  })
})
