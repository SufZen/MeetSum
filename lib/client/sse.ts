/**
 * Incremental SSE parser for fetch() streams (docs/parity/m6.md, D2; owner:
 * Package D). Pure and DOM-free so it can be unit tested in node.
 *
 * - Frames are separated by a blank line; LF, CRLF and CR all end a line,
 *   including a CRLF split across two chunks.
 * - `data:` lines are joined with "\n". JSON data is parsed; anything else is
 *   passed through as a string.
 * - Comments (`: keep-alive`), `id:` and `retry:` are ignored, as are frames
 *   without data.
 * - The event type is the `event:` field, else the parsed data's own `type`
 *   field, else `message`.
 */
export function createSseParser(onEvent: (type: string, data: unknown) => void): {
  push(chunk: string): void
  end(): void
} {
  let buffer = ""
  let started = false
  let ended = false
  /** The previous chunk ended with "\r": a leading "\n" belongs to it. */
  let pendingCr = false
  let eventType = ""
  let dataLines: string[] = []

  const dispatch = () => {
    if (dataLines.length) {
      const raw = dataLines.join("\n")
      let data: unknown = raw

      try {
        data = JSON.parse(raw)
      } catch {
        data = raw
      }

      const ownType =
        data && typeof data === "object" && typeof (data as { type?: unknown }).type === "string"
          ? (data as { type: string }).type
          : undefined

      onEvent(eventType || ownType || "message", data)
    }

    eventType = ""
    dataLines = []
  }

  const processLine = (line: string) => {
    if (line === "") {
      dispatch()
      return
    }
    if (line.startsWith(":")) return

    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? "" : line.slice(colon + 1)

    if (value.startsWith(" ")) value = value.slice(1)

    if (field === "event") eventType = value
    else if (field === "data") dataLines.push(value)
    // `id` and `retry` are irrelevant for a one-shot fetch stream.
  }

  return {
    push(chunk: string) {
      if (ended || !chunk) return

      let text = chunk

      if (!started) {
        started = true
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      }
      if (pendingCr && text.startsWith("\n")) text = text.slice(1)
      pendingCr = false

      buffer += text

      let start = 0

      for (let index = 0; index < buffer.length; index += 1) {
        const char = buffer[index]

        if (char !== "\n" && char !== "\r") continue

        processLine(buffer.slice(start, index))

        if (char === "\r") {
          if (index + 1 < buffer.length) {
            if (buffer[index + 1] === "\n") index += 1
          } else {
            pendingCr = true
          }
        }
        start = index + 1
      }

      buffer = buffer.slice(start)
    },
    end() {
      if (ended) return
      ended = true
      if (buffer) processLine(buffer)
      buffer = ""
      dispatch()
    },
  }
}
