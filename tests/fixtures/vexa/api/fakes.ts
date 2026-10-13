import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { vi } from "vitest"

import type { BotProvider } from "@/lib/bot/vexa/types"

const dirname = path.dirname(fileURLToPath(import.meta.url))

export function loadVexaFixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(path.join(dirname, name), "utf8")) as T
}

export function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

export type RecordedCall = { method: string; url: string; init: RequestInit; body?: unknown }
type Handler = (call: RecordedCall) => Response | Promise<Response>

/**
 * A fake fetch keyed by `"METHOD /path"` (path without origin/query). An array
 * value is consumed in order (the last entry repeats).
 */
export function fakeFetch(routes: Record<string, Handler | Handler[]>) {
  const calls: RecordedCall[] = []
  const counters = new Map<string, number>()

  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    const method = (init.method ?? "GET").toUpperCase()
    const { pathname } = new URL(url)
    const key = `${method} ${pathname}`
    const call: RecordedCall = {
      method,
      url,
      init,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    }

    calls.push(call)

    const route = routes[key]

    if (!route) return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 })

    const index = counters.get(key) ?? 0

    counters.set(key, index + 1)

    const handler = Array.isArray(route) ? route[Math.min(index, route.length - 1)] : route

    return handler(call)
  })

  return { fetch: fetchImpl as unknown as typeof fetch, calls }
}

/** A BotProvider whose methods are all vi.fn() (reject unless configured). */
export function fakeProvider(overrides: Partial<Record<keyof BotProvider, unknown>> = {}) {
  const unconfigured = (name: string) => vi.fn(async () => {
    throw new Error(`fake provider: ${name} not configured`)
  })
  const provider = {
    requestBot: unconfigured("requestBot"),
    stopBot: vi.fn(async () => ({ status: "stopping", raw: {} })),
    getMeeting: unconfigured("getMeeting"),
    findActiveBot: vi.fn(async () => undefined),
    getRecordingMaster: unconfigured("getRecordingMaster"),
    streamRecordingMedia: unconfigured("streamRecordingMedia"),
    getTranscript: unconfigured("getTranscript"),
    sendChat: vi.fn(async () => "sent" as const),
    deleteMeeting: vi.fn(async () => undefined),
    configureWebhook: vi.fn(async () => undefined),
    getWebhook: vi.fn(async () => ({ raw: {} })),
    health: vi.fn(async () => ({ ok: true })),
    ...overrides,
  }

  return provider as unknown as BotProvider & { [K in keyof BotProvider]: ReturnType<typeof vi.fn> }
}
