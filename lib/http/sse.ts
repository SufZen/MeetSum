/**
 * Server-sent events response (docs/parity/m6.md, C3; owner: Package C).
 *
 * STEP 0 STUB: serializes each event as `event: <type>` / `data: <json>`;
 * no keep-alive yet. Package C adds keep-alive, abort handling and errors.
 */
export function sseResponse(
  events: AsyncIterable<{ type: string }>,
  opts: { signal?: AbortSignal; keepAliveMs?: number; headers?: HeadersInit }
): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events) {
          if (opts.signal?.aborted) break
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
        }
      } finally {
        controller.close()
      }
    },
  })
  const headers = new Headers(opts.headers)

  headers.set("Content-Type", "text/event-stream; charset=utf-8")
  headers.set("Cache-Control", "no-cache, no-transform")
  headers.set("X-Accel-Buffering", "no")

  return new Response(body, { headers })
}
