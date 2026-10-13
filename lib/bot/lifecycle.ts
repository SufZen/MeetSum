import { getBotConfig } from "@/lib/bot/config"
import { enqueueBotJob } from "@/lib/bot/queue"
import { redactBotError } from "@/lib/bot/redact"
import {
  BotSessionConflictError,
  type BotEventSource,
  type BotSessionPatch,
  type BotSessionStore,
  type BotTransitionEvent,
} from "@/lib/bot/store"
import {
  BOT_STATUS_RANK,
  isTerminalBotStatus,
  type BotSession,
  type BotSessionRecord,
  type BotStatus,
  type BotStatusReason,
} from "@/lib/bot/types"
import type { VexaMeeting, VexaServiceProvenance } from "@/lib/bot/vexa/types"
import { notifyBotBlocked } from "@/lib/notifications/notify"
import { emitPlatformEvent } from "@/lib/platform/emit"

/**
 * Vexa-status lifecycle (M7 B2), shared by the webhook and reconcile.
 * `mapVexaStatus` and `applyBotStatus` are pure; `applyVexaSnapshot` runs the
 * rank-guarded store transition; `runBotSideEffects` enqueues the follow-up
 * bot jobs with idempotent job ids.
 */

export type BotStatusChange = {
  status: BotStatus
  reason: BotStatusReason | null
  /** Redacted Vexa reason for `failed/unknown` (stored in bot_sessions.error). */
  error?: string
}

export type MapVexaStatusContext = {
  /** Vexa failure/completion reason (zoom_requires_rtms, evicted, ...). */
  reason?: string | null
  provenance?: VexaServiceProvenance
  /** The session reached `active` before this event. */
  wasActive: boolean
  /** A user asked the bot to stop (DELETE) before Vexa finished. */
  stoppedByUser?: boolean
}

export type BotSideEffect = "enqueue_finalize" | "enqueue_consent" | "notify"

const ONE_TO_ONE: ReadonlySet<string> = new Set([
  "requested",
  "joining",
  "awaiting_admission",
  "needs_help",
  "active",
  "stopping",
])

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase()
}

function isEvicted(reason: string, outcome: string): boolean {
  return /evict|removed_by_host|kicked/.test(reason) || /evict|removed/.test(outcome)
}

function isNotAdmitted(reason: string): boolean {
  return /admission|not_admitted|never_admitted|denied|rejected|waiting_room|lobby/.test(reason)
}

/** Maps a Vexa status to ours (Model table); undefined = ignore (idle, scheduled). */
export function mapVexaStatus(
  vexaStatus: string,
  context: MapVexaStatusContext
): BotStatusChange | undefined {
  const status = normalize(vexaStatus)
  const reason = normalize(context.reason)
  const outcome = normalize(context.provenance?.botOutcome)

  if (ONE_TO_ONE.has(status)) return { status: status as BotStatus, reason: null }

  if (status === "completed") {
    if (isEvicted(reason, outcome)) {
      return context.wasActive
        ? { status: "completed", reason: "removed_by_host" }
        : { status: "blocked", reason: "removed_by_host" }
    }

    if (!context.wasActive && context.stoppedByUser) {
      return { status: "cancelled", reason: "user_stopped" }
    }

    if (outcome === "never_admitted" || !context.wasActive) {
      return { status: "blocked", reason: "not_admitted" }
    }

    if (/left_alone|alone/.test(reason)) return { status: "completed", reason: "left_alone" }
    return { status: "completed", reason: null }
  }

  if (status === "failed") {
    if (reason.includes("zoom_requires_rtms")) return { status: "blocked", reason: "platform_blocked" }
    if (reason.includes("auth_session_missing")) return { status: "blocked", reason: "bot_signed_out" }
    if (isNotAdmitted(reason) || outcome === "never_admitted") {
      return { status: "blocked", reason: "not_admitted" }
    }

    const detail = context.reason ? redactBotError(context.reason) : undefined

    return { status: "failed", reason: "unknown", ...(detail ? { error: detail } : {}) }
  }

  return undefined
}

/**
 * The bot was in the meeting: `joined_at` (stamped by the first applied
 * `active`) or Vexa's `bot_admitted_at`. `stopping` alone proves nothing: a
 * user may stop a bot that is still waiting in the lobby.
 */
export function botWasActive(
  session: Pick<BotSession, "joinedAt">,
  provenance?: VexaServiceProvenance
): boolean {
  return Boolean(session.joinedAt) || Boolean(provenance?.botAdmittedAt)
}

/**
 * Patch and side effects of moving `session` (its state before the change)
 * to `next`: `active` → consent; `completed` with recording enabled after the
 * bot reached `active` → finalize; blocked/failed never finalize.
 */
export function applyBotStatus(
  session: BotSession,
  next: BotStatusChange
): { patch: BotSessionPatch; sideEffects: BotSideEffect[] } {
  const patch: BotSessionPatch = {}
  const sideEffects: BotSideEffect[] = ["notify"]

  if (next.error) patch.error = next.error.slice(0, 500)

  if (next.status === "active" && session.consentStatus === "pending") {
    sideEffects.push("enqueue_consent")
  }

  // mapVexaStatus only yields `completed` once the bot reached `active`.
  if (next.status === "completed" && session.recordingEnabled) {
    sideEffects.push("enqueue_finalize")
  }

  return { patch, sideEffects }
}

/**
 * Follow-up jobs still owed by a session that already has `status` (a
 * redelivery after a failed enqueue, or a poll): consent not yet sent for an
 * active bot, finalize not yet run for a completed one. Job ids are
 * idempotent, so asking again never runs a job twice.
 */
export function pendingBotSideEffects(session: BotSession): BotSideEffect[] {
  if (session.status === "active" && session.consentStatus === "pending") return ["enqueue_consent"]
  if (
    session.status === "completed" &&
    session.recordingEnabled &&
    session.recordingStatus === "none" &&
    session.joinedAt
  ) {
    return ["enqueue_finalize"]
  }
  return []
}

export type ApplyVexaSnapshotOptions = {
  /** The bot_events row already recorded for this delivery (webhook). */
  event?: BotTransitionEvent
  at?: Date | string
  /**
   * When Vexa says the change happened (webhook payload timestamp). A lateral
   * lobby move older than the session's last status change is stale and is
   * not applied (higher/lower ranks are handled by the rank guard).
   */
  eventAt?: Date
}

/**
 * Applies a Vexa meeting snapshot (webhook or poll) through
 * `store.transition`, scoped to the session's own workspace. A late or
 * lateral-invalid status is recorded with `applied=false`.
 */
export async function applyVexaSnapshot(
  store: BotSessionStore,
  session: BotSessionRecord,
  vexaMeeting: Pick<VexaMeeting, "status"> & Partial<VexaMeeting>,
  source: BotEventSource,
  options: ApplyVexaSnapshotOptions = {}
): Promise<{ applied: boolean; session: BotSessionRecord; sideEffects: BotSideEffect[] }> {
  const scope = { workspaceId: session.workspaceId }
  let current = session

  // Adopt the Vexa meeting id when the session was resolved by target.
  if (!current.vexaMeetingId && vexaMeeting.id) {
    current =
      (await store
        .update(current.id, { vexaMeetingId: vexaMeeting.id }, scope)
        .catch((error: unknown) => {
          if (error instanceof BotSessionConflictError) return undefined
          throw error
        })) ?? current
  }

  const next = mapVexaStatus(String(vexaMeeting.status ?? ""), {
    reason: vexaMeeting.reason,
    provenance: vexaMeeting.serviceProvenance,
    wasActive: botWasActive(current, vexaMeeting.serviceProvenance),
    stoppedByUser: current.statusReason === "user_stopped",
  })

  const lateral =
    next !== undefined &&
    next.status !== current.status &&
    BOT_STATUS_RANK[next.status] === BOT_STATUS_RANK[current.status] &&
    !isTerminalBotStatus(next.status)
  const stale =
    lateral &&
    options.eventAt !== undefined &&
    current.statusChangedAt !== null &&
    options.eventAt.getTime() < Date.parse(current.statusChangedAt)

  if (!next || stale) {
    if (options.event?.eventId) {
      // Recorded but nothing to apply (idle/scheduled): keep applied=false.
      await store.transition(current.id, {
        status: current.status,
        at: options.at ?? new Date(),
        source,
        workspaceId: current.workspaceId,
        event: options.event,
      })
    }

    return { applied: false, session: current, sideEffects: [] }
  }

  const result = await store.transition(current.id, {
    status: next.status,
    reason: next.reason,
    at: options.at ?? new Date(),
    source,
    workspaceId: current.workspaceId,
    event: options.event,
  })

  if (!result) return { applied: false, session: current, sideEffects: [] }
  if (!result.applied) {
    // Already there (e.g. Vexa's retry after our failed enqueue): re-ask for
    // what is still owed so a lost side effect is never silently dropped.
    const owed = result.session.status === next.status ? pendingBotSideEffects(result.session) : []

    return { applied: false, session: result.session, sideEffects: owed }
  }

  const { patch, sideEffects } = applyBotStatus(result.previous, next)
  const updated = Object.keys(patch).length
    ? ((await store.update(current.id, patch, scope)) ?? result.session)
    : result.session

  return { applied: true, session: updated, sideEffects }
}

/**
 * Enqueues the bot jobs a status change asks for. Job ids are idempotent per
 * session (`bot.finalize:<id>`, `bot.consent:<id>`), so duplicate webhooks
 * and reconcile runs enqueue at most one of each.
 */
export async function runBotSideEffects(
  // M8: status/meetingId/statusReason feed `bot.status_changed` (type-only widening).
  session: Pick<BotSession, "id" | "workspaceId"> & Partial<Pick<BotSession, "status" | "meetingId" | "statusReason">>,
  sideEffects: readonly BotSideEffect[],
  deps: { enqueue?: typeof enqueueBotJob; finalizeAttempts?: number } = {}
): Promise<void> {
  const enqueue = deps.enqueue ?? enqueueBotJob
  const payload = { sessionId: session.id, workspaceId: session.workspaceId }

  if (sideEffects.includes("notify")) {
    await emitPlatformEvent({ workspaceId: session.workspaceId }, "bot.status_changed", { sessionId: session.id, meetingId: session.meetingId ?? null, status: session.status ?? null, reason: session.statusReason ?? null }).catch(() => {})
    if (session.status === "blocked" && session.meetingId) {
      await notifyBotBlocked({ workspaceId: session.workspaceId, meetingId: session.meetingId, sessionId: session.id }).catch(() => {})
    }
  }

  if (sideEffects.includes("enqueue_consent")) {
    await enqueue("bot.consent", payload, { jobId: `bot.consent:${session.id}` })
  }

  if (sideEffects.includes("enqueue_finalize")) {
    await enqueue("bot.finalize", payload, {
      jobId: `bot.finalize:${session.id}`,
      attempts: deps.finalizeAttempts ?? getBotConfig().finalizeAttempts,
    })
  }
}
