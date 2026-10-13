import { NextResponse } from "next/server"

import { auditActor } from "@/app/api/_lib/meeting-access"
import { DEFAULT_ASR_GLOSSARY } from "@/lib/ai/asr"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import {
  ASR_GLOSSARY_LIMITS,
  getAsrGlossary,
  parseAsrGlossary,
  updateAsrGlossary,
} from "@/lib/settings/asr-glossary"

/**
 * GET /api/asr/glossary — the workspace's effective ASR glossary (built-in
 * defaults merged with the workspace terms), the read-only defaults and the
 * limits.
 */
export const GET = withAuthz("workspace:read", async (request, ctx) => {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.api)

  if (rateLimit.blocked) return rateLimit.blocked

  const glossary = await getAsrGlossary(ctx.workspace.id)

  return NextResponse.json(
    { glossary, defaults: DEFAULT_ASR_GLOSSARY, limits: ASR_GLOSSARY_LIMITS },
    { headers: rateLimit.headers }
  )
})

/**
 * PUT /api/asr/glossary — replaces the workspace terms.
 * Body: `{version: 1, terms: [...]}` (or `{glossary: {...}}`). Invalid input
 * answers 400 with per-field errors (`terms.3.aliases.1`).
 */
export const PUT = withAuthz("settings:write", async (request, ctx) => {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.api)

  if (rateLimit.blocked) return rateLimit.blocked

  const body = (await request.json().catch(() => undefined)) as unknown
  const payload =
    typeof body === "object" && body !== null && "glossary" in body
      ? (body as { glossary: unknown }).glossary
      : body
  const parsed = parseAsrGlossary(payload)

  if (!parsed.ok) {
    return NextResponse.json(
      { error: "Invalid glossary", fieldErrors: parsed.errors },
      { status: 400, headers: rateLimit.headers }
    )
  }

  const glossary = await updateAsrGlossary(ctx.workspace.id, parsed.glossary)

  await recordAuditLog({
    ...auditActor(ctx),
    action: "asr.glossary.updated",
    targetType: "workspace",
    targetId: ctx.workspace.id,
    metadata: {
      terms: parsed.glossary.terms.length,
      hotwords: parsed.glossary.terms.filter((term) => term.hotword).length,
    },
  })

  return NextResponse.json(
    { glossary, defaults: DEFAULT_ASR_GLOSSARY, limits: ASR_GLOSSARY_LIMITS },
    { headers: rateLimit.headers }
  )
})
