import { createHash } from "node:crypto"

import { getBotConfig, type BotConfig } from "@/lib/bot/config"
import { applyVexaSnapshot, runBotSideEffects } from "@/lib/bot/lifecycle"
import type { enqueueBotJob } from "@/lib/bot/queue"
import { redactBotError } from "@/lib/bot/redact"
import { getBotSessionStore, type BotSessionStore } from "@/lib/bot/store"
import { BOT_PLATFORMS, type BotPlatform } from "@/lib/bot/types"
import type { VexaServiceProvenance } from "@/lib/bot/vexa/types"
import { verifyVexaSignature } from "@/lib/bot/webhook-verify"
import { getLogger } from "@/lib/log"

const log = getLogger({ component: "bot" })

/**
 * Vexa webhook processing (M7 B3). The route only adapts HTTP; everything
 * else lives here so it is testable without Next.
 *
 * The workspace is resolved ONLY from the stored bot_session
 * (`store.getForWebhook`); nothing in the payload can address a workspace.
 * Unknown sessions get a 2xx no-op that looks the same whether or not the
 * meeting exists anywhere. Deliveries are idempotent per event id and per
 * (workspace, vexa_meeting_id, event type, status, previous status) — the
 * previous status is Vexa's when the envelope has it, else the session's at
 * receipt — so awaiting_admission → needs_help → awaiting_admission are three
 * events; a delivery without an event id is keyed by a hash of its signed
 * body, so a byte-identical replay is always a duplicate. An event whose apply
 * or side-effect enqueue fails is deleted again (500) so Vexa's retry is
 * reprocessed. No Vexa call happens inside the request.
 */

export const VEXA_WEBHOOK_MAX_BYTES = 256 * 1024

export type CappedBodyResult = { ok: true; text: string } | { ok: false; reason: "too_large" }

/**
 * Reads a request body as UTF-8 while counting bytes, BEFORE any JSON parse
 * or HMAC: a declared Content-Length above `maxBytes` is refused without
 * reading, and the stream is cancelled as soon as the bytes actually read
 * exceed `maxBytes` (a missing or lying Content-Length cannot make the
 * server buffer more than the cap plus one chunk).
 */
export async function readBodyCapped(
  request: Request,
  maxBytes: number = VEXA_WEBHOOK_MAX_BYTES
): Promise<CappedBodyResult> {
  const declaredHeader = request.headers.get("content-length")

  if (declaredHeader !== null && declaredHeader.trim() !== "") {
    const declared = Number(declaredHeader)

    if (!Number.isFinite(declared) || declared < 0 || declared > maxBytes) {
      await request.body?.cancel().catch(() => undefined)
      return { ok: false, reason: "too_large" }
    }
  }

  if (!request.body) return { ok: true, text: "" }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()

    if (done) break
    if (!value) continue

    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return { ok: false, reason: "too_large" }
    }
    chunks.push(value)
  }

  return { ok: true, text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8") }
}

export type ParsedVexaWebhook = {
  eventType: string
  eventId?: string
  vexaMeetingId?: string
  platform?: BotPlatform
  nativeMeetingId?: string
  status?: string
  /** Vexa's status before this change, when the envelope carries it. */
  previousStatus?: string
  /** Vexa's event time, when the envelope carries a parseable one. */
  occurredAt?: Date
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

/** ISO string or epoch seconds/milliseconds → Date; undefined when unusable. */
function eventTime(value: string | undefined): Date | undefined {
  if (!value) return undefined

  const numeric = /^\d+(\.\d+)?$/.test(value) ? Number(value) : Number.NaN
  const ms = Number.isFinite(numeric) ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(value)

  return Number.isFinite(ms) ? new Date(ms) : undefined
}

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
    occurredAt: eventTime(
      first(root.timestamp, root.created_at, root.occurred_at, data.timestamp, data.changed_at, data.updated_at)
    ),
    previousStatus: first(
      data.old_status,
      data.previous_status,
      data.from_status,
      root.old_status,
      root.previous_status
    )
      ?.toLowerCase()
      .slice(0, 50),
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
    // Strict per-delivery dedupe: Vexa's event id, else a hash of the signed
    // body, so a byte-identical replay (captured or retried) never re-applies.
    vexaEventId: parsed.eventId ?? `sha256:${createHash("sha256").update(input.rawBody).digest("hex")}`,
    eventType: parsed.eventType,
    vexaStatus: parsed.status ?? null,
    prevStatus: parsed.previousStatus ?? session.status,
    applied: false,
    payload,
    receivedAt: now.toISOString(),
  })

  if (recorded.duplicate) return { status: 200, body: { duplicate: true } }
  if (!parsed.status) return { status: 200, body: { ok: true, applied: false } }

  // Vexa's own event time (never in the future): orders lateral lobby moves.
  const eventAt =
    parsed.occurredAt && parsed.occurredAt.getTime() < now.getTime() ? parsed.occurredAt : undefined
  let outcome: Awaited<ReturnType<typeof applyVexaSnapshot>>

  // Record + apply + side-effect enqueue succeed together, or the delivery is
  // un-recorded and answered 500, so Vexa's retry is reprocessed (the retry
  // re-asks for any job still owed; job ids keep that idempotent). A process
  // crash mid-way is healed by reconcile's poll of the Vexa status.
  try {
    outcome = await applyVexaSnapshot(
      store,
      session,
      {
        id: parsed.vexaMeetingId,
        status: parsed.status,
        reason: parsed.reason,
        serviceProvenance: parsed.provenance,
      },
      "webhook",
      { event: { eventId: recorded.event?.id }, at: eventAt ?? now, eventAt }
    )

    if (outcome.sideEffects.length) {
      await runBotSideEffects(outcome.session, outcome.sideEffects, {
        enqueue: deps.enqueue,
        finalizeAttempts: config.finalizeAttempts,
      })
    }
  } catch (error) {
    // Un-record the delivery so Vexa's retry (after our 500) is not deduped.
    if (recorded.event?.id) {
      await store
        .deleteEvent(recorded.event.id, { workspaceId: session.workspaceId })
        .catch((cleanup: unknown) => log.error({ error: redactBotError(cleanup) }, "[bot] webhook event cleanup failed"))
    }
    throw error
  }

  return { status: 200, body: { ok: true, applied: outcome.applied } }
}
