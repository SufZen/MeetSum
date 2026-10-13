/**
 * Small helpers shared by the manual export routes (Notion, Google Docs).
 * Owner: Package C.
 */
import { NextResponse } from "next/server"

import { ProviderError, type ProviderErrorKind } from "@/lib/integrations/core/types"

/** Private, or unknown visibility (treated as private). */
export function isPrivateMeeting(meeting: { visibility?: string }): boolean {
  return meeting.visibility !== "workspace" && meeting.visibility !== "link"
}

/** A client `Idempotency-Key` (uuid-like), else a fresh uuid; always `manual:`-prefixed. */
export function manualIdempotencyKey(request: Request): string {
  const header = request.headers.get("idempotency-key")?.trim()
  const key = header && /^[A-Za-z0-9_-]{8,128}$/.test(header) ? header : crypto.randomUUID()

  return `manual:${key}`
}

/** The JSON body as a plain object (`{}` when missing or not an object). */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const parsed = (await request.json().catch(() => ({}))) as unknown

  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
}

const STATUS_BY_KIND: Record<ProviderErrorKind, number> = {
  auth: 409,
  forbidden: 403,
  not_found: 404,
  invalid: 422,
  rate_limited: 429,
  retryable: 502,
  config: 409,
}

const SUFFIX_BY_KIND: Record<ProviderErrorKind, string> = {
  auth: "needs_reauth",
  forbidden: "forbidden",
  not_found: "not_found",
  invalid: "invalid_request",
  rate_limited: "rate_limited",
  retryable: "unavailable",
  config: "not_connected",
}

/**
 * A provider failure as a fixed `{error: "<prefix>_<code>"}`: the provider's
 * own message is never reflected. `Retry-After` is passed on for 429.
 */
export function providerErrorResponse(prefix: "notion" | "google_docs", error: unknown): Response {
  if (!(error instanceof ProviderError)) {
    return NextResponse.json({ error: `${prefix}_export_failed` }, { status: 502 })
  }

  const headers: Record<string, string> = {}

  if (error.kind === "rate_limited" && error.retryAfterMs !== undefined) {
    headers["retry-after"] = String(Math.max(1, Math.ceil(error.retryAfterMs / 1000)))
  }

  return NextResponse.json(
    { error: `${prefix}_${SUFFIX_BY_KIND[error.kind]}` },
    { status: STATUS_BY_KIND[error.kind], headers }
  )
}
