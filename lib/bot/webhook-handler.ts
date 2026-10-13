import { getBotConfig, type BotConfig } from "@/lib/bot/config"
import { applyVexaSnapshot, runBotSideEffects } from "@/lib/bot/lifecycle"
import type { enqueueBotJob } from "@/lib/bot/queue"
import { redactBotError } from "@/lib/bot/redact"
import { getBotSessionStore, type BotSessionStore } from "@/lib/bot/store"
import { BOT_PLATFORMS, type BotPlatform } from "@/lib/bot/types"
import type { VexaServiceProvenance } from "@/lib/bot/vexa/types"
import { verifyVexaSignature } from "@/lib/bot/webhook-verify"

/**
 * Vexa webhook processing (M7 B3). The route only adapts HTTP; everything
 * else lives here so it is testable without Next.
 *
 * The workspace is resolved ONLY from the stored bot_session
 * (`store.getForWebhook`); nothing in the payload can address a workspace.
 * Unknown sessions get a 2xx no-op that looks the same whether or not the
 * meeting exists anywhere. Deliveries are idempotent per
 * (workspace, vexa_meeting_id, event type, status) and per event id. No Vexa
 * call happens inside the request.
 */

export const VEXA_WEBHOOK_MAX_BYTES = 256 * 1024

export type ParsedVexaWebhook = {
  eventType: string
  eventId?: string
  vexaMeetingId?: string
  platform?: BotPlatform
  nativeMeetingId?: string
  status?: string
  reason?: string
  provenance?: VexaServiceProvenance
}

export type VexaWebhookResult = {
  status: number
  body: Record<string, unknown>
}

export type VexaWebhookDeps = {
  store?: BotSessionStore
  config?: BotConfig
  enqueue?: typeof enqueueBotJob
  now?: () => Date
}

type Json = Record<string, unknown>

function object(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined
}

function str(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return undefined
}

function first(...values: unknown[]): string | undefined {
  for (const value of values) {
    const found = str(value)

    if (found) return found
  }

  return undefined
}

function provenanceFrom(value: unknown): VexaServiceProvenance | undefined {
  const source = object(value)

  if (!source) return undefined

  const provenance: VexaServiceProvenance = {
    botAdmittedAt: first(source.bot_admitted_at, source.botAdmittedAt),
    botDepartedAt: first(source.bot_departed_at, source.botDepartedAt),
    botOutcome: first(source.bot_outcome, source.botOutcome),
    transcriptionProvider: first(source.transcription_provider, source.transcriptionProvider),
    lifecycleContractVersion: first(
      source.lifecycle_contract_version,
      source.lifecycleContractVersion
    ),
  }

  return Object.values(provenance).some(Boolean) ? provenance : undefined
}

const PLATFORMS: ReadonlySet<string> = new Set(BOT_PLATFORMS)

/** Tolerant envelope parsing (the envelope is undocumented in 0.12.28). */
export function parseVexaWebhook(body: unknown): ParsedVexaWebhook | undefined {
  const root = object(body)

  if (!root) return undefined

  const data = object(root.data) ?? {}
  const meeting = object(data.meeting) ?? object(root.meeting) ?? {}
  const meetingData = object(meeting.data) ?? {}
  const eventType = first(root.event_type, root.event, root.type) ?? "meeting.status_change"
  const vexaMeetingId = first(meeting.id, data.meeting_id, root.meeting_id)
  const rawEventId = first(root.event_id, root.delivery_id, root.webhook_id, root.id)
  const platform = first(meeting.platform, data.platform, root.platform)
  let status = first(
    meeting.status,
    data.new_status,
    data.status,
    root.new_status,
    root.status
  )

  // `bot.failed` is always a failure, whatever status it echoes.
  if (eventType === "bot.failed") status = "failed"
  if (!status && eventType === "meeting.completed") status = "completed"
  if (!status && eventType === "meeting.started") status = "active"

  return {
    eventType: eventType.slice(0, 100),
    // A bare `id` that is really the meeting id would collapse every event.
    eventId: rawEventId && rawEventId !== vexaMeetingId ? rawEventId.slice(0, 200) : undefined,
    vexaMeetingId: vexaMeetingId?.slice(0, 200),
    platform: platform && PLATFORMS.has(platform) ? (platform as BotPlatform) : undefined,
    nativeMeetingId: first(meeting.native_meeting_id, data.native_meeting_id, root.native_meeting_id)
      ?.slice(0, 300),
    status: status?.toLowerCase().slice(0, 50),
    reason: first(
      meetingData.reason,
      meeting.reason,
      data.reason,
      root.reason,
      meetingData.failure_reason,
      data.failure_reason,
      data.error,
      root.error
    )?.slice(0, 300),
    provenance:
      provenanceFrom(meetingData.service_provenance) ??
      provenanceFrom(meeting.service_provenance) ??
      provenanceFrom(data.service_provenance),
  }
}

const SENSITIVE_KEY = /secret|token|password|passcode|pwd|authorization|api[_-]?key|cookie/i

/** Strips URL queries/fragments and secret-looking keys (stored in bot_events). */
export function redactWebhookPayload(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]"
  if (typeof value === "string") {
    const stripped = value.replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, "$1")

    return stripped.length > 1000 ? `${stripped.slice(0, 999)}…` : stripped
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactWebhookPayload(item, depth + 1))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Json)
        .filter(([key]) => !SENSITIVE_KEY.test(key))
        .slice(0, 100)
        .map(([key, item]) => [key, redactWebhookPayload(item, depth + 1)])
    )
  }

  return value
}

/** Full webhook flow after the HTTP layer has read the raw body. */
export async function processVexaWebhook(
  input: { headers: Headers; rawBody: string },
  deps: VexaWebhookDeps = {}
): Promise<VexaWebhookResult> {
  const config = deps.config ?? getBotConfig()
  const secret = config.vexa.webhookSecret
  const now = deps.now?.() ?? new Date()

  if (!config.enabled || !secret) {
    return { status: 503, body: { error: "bot_webhook_unavailable" } }
  }

  if (Buffer.byteLength(input.rawBody, "utf8") > VEXA_WEBHOOK_MAX_BYTES) {
    return { status: 413, body: { error: "payload_too_large" } }
  }

  const verified = verifyVexaSignature(input.headers, input.rawBody, secret, now, {
    toleranceSeconds: config.vexa.webhookToleranceSeconds,
    allowBearer: config.vexa.webhookAllowBearer,
  })

  if (!verified.ok) return { status: 401, body: { error: "unauthorized" } }

  let body: unknown

  try {
    body = JSON.parse(input.rawBody)
  } catch {
    return { status: 400, body: { error: "invalid_json" } }
  }

  const parsed = parseVexaWebhook(body)

  if (!parsed || (!parsed.vexaMeetingId && !(parsed.platform && parsed.nativeMeetingId))) {
    return { status: 200, body: { ignored: true } }
  }

  const store = deps.store ?? getBotSessionStore()
  const session = await store.getForWebhook({
    vexaMeetingId: parsed.vexaMeetingId,
    platform: parsed.platform,
    nativeMeetingId: parsed.nativeMeetingId,
  })

  // Same answer whether the meeting is unknown or belongs to nobody we track.
  if (!session) return { status: 200, body: { ignored: true } }

  const payload = redactWebhookPayload(body) as Json
  const recorded = await store.recordEvent({
    botSessionId: session.id,
    workspaceId: session.workspaceId,
    source: "webhook",
    vexaMeetingId: parsed.vexaMeetingId ?? session.vexaMeetingId,
    vexaEventId: parsed.eventId,
    eventType: parsed.eventType,
    vexaStatus: parsed.status ?? null,
    applied: false,
    payload,
    receivedAt: now.toISOString(),
  })

  if (recorded.duplicate) return { status: 200, body: { duplicate: true } }
  if (!parsed.status) return { status: 200, body: { ok: true, applied: false } }

  const outcome = await applyVexaSnapshot(
    store,
    session,
    {
      id: parsed.vexaMeetingId,
      status: parsed.status,
      reason: parsed.reason,
      serviceProvenance: parsed.provenance,
    },
    "webhook",
    { event: { eventId: recorded.event?.id }, at: now }
  )

  if (outcome.sideEffects.length) {
    // The event is recorded either way; reconcile recovers a failed enqueue.
    await runBotSideEffects(outcome.session, outcome.sideEffects, {
      enqueue: deps.enqueue,
      finalizeAttempts: config.finalizeAttempts,
    }).catch((error: unknown) => {
      console.error("[bot] webhook side effects failed", redactBotError(error))
    })
  }

  return { status: 200, body: { ok: true, applied: outcome.applied } }
}
