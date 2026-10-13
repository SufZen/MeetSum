/**
 * Minimal Server-Sent Events framing for the M7 live transcript route (B8).
 *
 * M7-owned stand-in for the M5/M6 SSE helpers: M7 branches from M4 and runs
 * in parallel, so those helpers are not available yet. Consolidate onto the
 * shared helpers at the M5/M6/M7 integration. Owned by Package B.
 */

export const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
})

function lines(field: string, value: string): string {
  return value
    .split(/\r\n|\r|\n/)
    .map((line) => `${field}: ${line}`)
    .join("\n")
}

/** One `event:`/`id:`/`data:` frame; `data` is JSON-encoded unless a string. */
export function formatSseEvent(event: string, data: unknown, id?: string): string {
  const parts: string[] = []

  if (id !== undefined) parts.push(lines("id", id.replace(/[\r\n]/g, "")))
  parts.push(lines("event", event.replace(/[\r\n]/g, "")))
  parts.push(lines("data", typeof data === "string" ? data : JSON.stringify(data)))

  return `${parts.join("\n")}\n\n`
}

/** A comment frame (keep-alive). */
export function formatSseComment(comment = "keep-alive"): string {
  return `${lines("", comment)}\n\n`
}
