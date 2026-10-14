import { getLogger } from "@/lib/log"

const log = getLogger({ component: "http" })

/**
 * Server-sent events response (docs/parity/m6.md, C8; owner: Package C).
 *
 * - Frames: `event: <type>\ndata: <json>\n\n` (JSON never contains a raw
 *   newline, so one `data:` line per frame).
 * - A `: keep-alive` comment every `keepAliveMs` (15 s) while the producer
 *   is quiet, so proxies keep the connection open.
 * - The request `signal` aborting, or the client cancelling the body, stops
 *   reading and calls `return()` on the producer, whose `finally` releases
 *   the upstream LLM stream. The producer also receives the same signal.
 * - A producer failure becomes a generic `error` event: the error message is
 *   never sent or logged (it can carry prompt or transcript fragments).
 */
export const SSE_KEEP_ALIVE_MS = 15_000

const encoder = new TextEncoder()

export function sseFrame(event: { type: string }): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

export function sseResponse(
  events: AsyncIterable<{ type: string }>,
  opts: { signal?: AbortSignal; keepAliveMs?: number; headers?: HeadersInit }
): Response {
  const iterator = events[Symbol.asyncIterator]()
  const keepAliveMs = opts.keepAliveMs ?? SSE_KEEP_ALIVE_MS
  let finished = false
  let timer: ReturnType<typeof setInterval> | undefined

  const stopProducer = () => {
    if (timer) clearInterval(timer)
    timer = undefined
    // Errors from an already-closed generator are irrelevant here.
    void Promise.resolve(iterator.return?.()).catch(() => {})
  }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (text: string) => {
        if (finished) return
        try {
          controller.enqueue(encoder.encode(text))
        } catch {
          finished = true
        }
      }
      const finish = () => {
        if (finished) return
        finished = true
        stopProducer()
        try {
          controller.close()
        } catch {
          // Already closed or cancelled.
        }
      }
      const onAbort = () => finish()

      if (opts.signal?.aborted) {
        finish()
        return
      }
      opts.signal?.addEventListener("abort", onAbort, { once: true })
      if (keepAliveMs > 0) timer = setInterval(() => enqueue(": keep-alive\n\n"), keepAliveMs)

      try {
        for (;;) {
          const next = await iterator.next()

          if (next.done || finished || opts.signal?.aborted) break
          enqueue(sseFrame(next.value))
        }
      } catch (error) {
        if (!finished && !opts.signal?.aborted) {
          // Name only: messages may contain prompt or transcript fragments.
          log.error({ errorName: error instanceof Error ? error.name : "unknown error" }, "SSE producer failed:")
          enqueue(sseFrame({ type: "error", code: "internal", message: "Internal error" } as { type: string }))
        }
      } finally {
        opts.signal?.removeEventListener("abort", onAbort)
        finish()
      }
    },
    cancel() {
      finished = true
      stopProducer()
    },
  })
  const headers = new Headers(opts.headers)

  headers.set("Content-Type", "text/event-stream; charset=utf-8")
  headers.set("Cache-Control", "no-cache, no-transform")
  headers.set("X-Accel-Buffering", "no")

  return new Response(body, { headers })
}
