/**
 * Shared helpers for the M8 integration routes. Owner: Package A. Errors
 * are fixed codes only (never provider text); rate limits are keyed per
 * user (or API key) and workspace.
 */
import { NextResponse } from "next/server"

import type { AuthContext } from "@/lib/auth/authz"
import type { IntegrationAuditActor } from "@/lib/integrations/core/audit"
import { ProviderError } from "@/lib/integrations/core/types"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

export function apiError(code: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: code, ...extra }, { status })
}

export function principalKey(ctx: Pick<AuthContext, "user" | "apiKey" | "workspace">): string {
  return `${ctx.workspace.id}:${ctx.user?.id ?? `key:${ctx.apiKey?.id ?? "anon"}`}`
}

/** 429 Response when the preset is exhausted for this principal, else undefined. */
export function limitFor(
  request: Request,
  ctx: Pick<AuthContext, "user" | "apiKey" | "workspace">,
  preset: "integrationsOAuth" | "integrationsWrite" | "integrationsSend"
): Promise<Response | undefined> {
  return rateLimitRequest(request, RATE_LIMIT_PRESETS[preset], `${preset}:${principalKey(ctx)}`).then((result) => result.blocked)
}

/** The acting user id (API keys act for their creator). */
export function actorUserId(ctx: Pick<AuthContext, "user" | "apiKey">): string | undefined {
  return ctx.user?.id ?? ctx.apiKey?.createdByUserId
}

export function auditActor(ctx: Pick<AuthContext, "audit">): IntegrationAuditActor {
  return ctx.audit
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

/** Fixed HTTP mapping for a provider failure (never the provider's text). */
export function providerErrorResponse(error: unknown): Response {
  if (error instanceof ProviderError) {
    const status = error.kind === "auth" ? 409 : error.kind === "rate_limited" ? 429 : error.kind === "invalid" || error.kind === "not_found" ? 400 : 502
    const code = error.kind === "auth" ? "integration_needs_reauth" : error.kind === "config" ? "integration_not_configured" : `provider_${error.kind}`

    return apiError(code, status, /^[a-z_]{1,64}$/.test(error.providerCode ?? "") ? { providerCode: error.providerCode } : {})
  }
  return apiError("provider_error", 502)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A client `Idempotency-Key` (uuid), else undefined. */
export function idempotencyKeyOf(request: Request): string | undefined {
  const value = request.headers.get("idempotency-key")?.trim()

  return value && UUID.test(value) ? value.toLowerCase() : undefined
}
