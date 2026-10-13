import { readFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"

import type { ExecFileFn } from "@/lib/ai/asr/audio"

/**
 * Test doubles for the ASR providers: an execFile that pretends to be
 * ffmpeg/ffprobe (writes a tiny fake OGG for every output path) and a
 * route-table fetch that records every request.
 */

export type ExecCall = { file: string; args: string[] }

export function fakeExecFile(options: { durationMs: number; silenceStderr?: string; fail?: Error }) {
  const calls: ExecCall[] = []
  const execFile: ExecFileFn = async (file, args) => {
    calls.push({ file, args })

    if (options.fail) throw options.fail
    if (file === "ffprobe") return { stdout: `${(options.durationMs / 1000).toFixed(3)}\n`, stderr: "" }
    if (args.some((arg) => arg.startsWith("silencedetect"))) {
      return { stdout: "", stderr: options.silenceStderr ?? "" }
    }

    const output = args[args.length - 1]

    if (output && output !== "-") await writeFile(output, Buffer.from("OggS-fake-audio"))
    return { stdout: "", stderr: "" }
  }

  return { execFile, calls }
}

export type RecordedRequest = {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

type Handler = (request: RecordedRequest) => Response | Promise<Response>

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function headersOf(init?: RequestInit): Record<string, string> {
  const result: Record<string, string> = {}

  new Headers(init?.headers).forEach((value, key) => {
    result[key] = value
  })
  return result
}

/**
 * `routes` maps "METHOD url-substring" to a handler (or a queue of
 * handlers consumed in order, the last one repeating).
 */
export function mockFetch(routes: Record<string, Handler | Handler[]>) {
  const requests: RecordedRequest[] = []
  const queues = new Map(Object.entries(routes).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]))

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = (init?.method ?? "GET").toUpperCase()
    let body: unknown = init?.body

    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }

    const request = { url, method, headers: headersOf(init), body }

    requests.push(request)

    for (const [key, queue] of queues) {
      const [routeMethod, fragment] = key.split(" ")

      if (routeMethod === method && url.includes(fragment)) {
        const handler = queue.length > 1 ? queue.shift()! : queue[0]

        return handler(request)
      }
    }

    throw new Error(`Unexpected request ${method} ${url}`)
  }) as typeof fetch

  return { fetch: fetchFn, requests }
}

/** Loads a JSON fixture from this directory (all are `_synthetic`). */
export function loadFixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8")) as T
}

/** Instant sleep that records requested delays. */
export function recordingSleep() {
  const delays: number[] = []

  return {
    delays,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
      delays.push(ms)
    },
  }
}
