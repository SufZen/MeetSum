/**
 * Fake `ProviderFetch` for M8 Package B tests: routes `"<METHOD> <url-prefix>"`
 * to recorded fixture responses and records every call. No network.
 */
import { readFileSync } from "node:fs"

import type { ProviderFetch, ProviderId } from "@/lib/integrations/core/types"

export type RecordedCall = {
  provider: ProviderId
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

export type FakeRoute = {
  /** e.g. `"POST https://api.hubapi.com/crm/v3/objects/contacts/search"`; matched as a prefix. */
  match: string
  respond: (call: RecordedCall, index: number) => { status?: number; body?: unknown; headers?: Record<string, string> }
}

export function fixture<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(`tests/fixtures/integrations/${path}`, "utf8")) as T
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return () => ({ status, body, headers })
}

function parseBody(body: RequestInit["body"]): unknown {
  if (typeof body !== "string") return body ?? undefined
  try {
    return JSON.parse(body)
  } catch {
    return Object.fromEntries(new URLSearchParams(body))
  }
}

export function createFakeFetch(routes: FakeRoute[]) {
  const calls: RecordedCall[] = []
  const hits = new Map<FakeRoute, number>()

  const fetch: ProviderFetch = async (provider, url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase()
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    const call: RecordedCall = { provider, method, url, headers, body: parseBody(init.body) }

    calls.push(call)

    const route = routes.find((candidate) => `${method} ${url}`.startsWith(candidate.match))

    if (!route) return new Response(JSON.stringify({ error: "no fake route" }), { status: 599 })

    const index = hits.get(route) ?? 0

    hits.set(route, index + 1)

    const result = route.respond(call, index)
    const status = result.status ?? 200

    return new Response(status === 204 || result.body === undefined ? null : JSON.stringify(result.body), {
      status,
      headers: { "content-type": "application/json", ...(result.headers ?? {}) },
    })
  }

  return { fetch, calls }
}
