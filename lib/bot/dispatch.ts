import { UnrecoverableError } from "bullmq"

import { decryptSecret, encryptSecret } from "@/lib/auth/secret-crypto"
import { type BotConfig, getBotConfig } from "@/lib/bot/config"
import { type MeetingLinkSecrets, meetingLinkSecrets, rebuildCanonicalUrl } from "@/lib/bot/meeting-url"
import { defaultBotQueuePort, dispatchJobId, type BotQueuePort } from "@/lib/bot/queue"
import { botLog, redactBotError } from "@/lib/bot/redact"
import { ensureRecordingBotName, joinWindowEnd } from "@/lib/bot/rules"
import { BotSessionConflictError, type BotSessionStore, getBotSessionStore } from "@/lib/bot/store"
import type {
  BotSession,
  BotSessionRecord,
  BotStatus,
  BotStatusReason,
  ParsedMeetingLink,
} from "@/lib/bot/types"
import { getBotProvider } from "@/lib/bot/vexa/client"
import { type BotProvider, VexaError, type VexaBotRequest } from "@/lib/bot/vexa/types"

/**
 * Bot dispatcher (M7 A6): delayed `bot.dispatch` jobs, rank/rev-guarded
 * dispatch, conflict adoption and capacity re-delay.
 *
 * `dispatch_rev` is the idempotency guard: every reschedule bumps it and the
 * job id (`bot.dispatch:<id>:<rev>`), so a stale delayed job is a no-op.
 */

/** Capacity / admission re-delay. */
export const BOT_REDELAY_MS = 60_000

export type DispatchDeps = {
  store: BotSessionStore
  provider: () => BotProvider
  queue: BotQueuePort
  config: BotConfig
  now: () => Date
  openSecrets: (sealed: string | null) => MeetingLinkSecrets
}

export function resolveDispatchDeps(deps: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    store: deps.store ?? getBotSessionStore(),
    provider: deps.provider ?? getBotProvider,
    queue: deps.queue ?? defaultBotQueuePort,
    config: deps.config ?? getBotConfig(),
    now: deps.now ?? (() => new Date()),
    openSecrets: deps.openSecrets ?? openMeetingSecrets,
  }
}

/**
 * Encrypts what the redacted URL drops (passcode, Teams `context`) for
 * `bot_sessions.passcode_enc`. Null when the link carries no secret.
 */
export function sealMeetingSecrets(link: Pick<ParsedMeetingLink, "platform" | "passcode" | "canonicalUrl">): string | null {
  const secrets = meetingLinkSecrets(link as ParsedMeetingLink)

  if (!secrets.passcode && !secrets.teamsContext) return null
  return encryptSecret(JSON.stringify({ v: 1, ...secrets }))
}

/** Inverse of sealMeetingSecrets; a plain encrypted passcode is accepted too. */
export function openMeetingSecrets(sealed: string | null): MeetingLinkSecrets {
  if (!sealed) return {}

  let plain: string

  try {
    plain = decryptSecret(sealed)
  } catch {
    return {}
  }

  try {
    const parsed = JSON.parse(plain) as { v?: unknown; passcode?: unknown; teamsContext?: unknown }

    if (parsed && typeof parsed === "object" && parsed.v === 1) {
      return {
        ...(typeof parsed.passcode === "string" ? { passcode: parsed.passcode } : {}),
        ...(typeof parsed.teamsContext === "string" ? { teamsContext: parsed.teamsContext } : {}),
      }
    }
  } catch {
    // A bare passcode.
  }

  return { passcode: plain }
}

export type DispatchOutcome =
  | "skipped"
  | "requested"
  | "adopted"
  | "redelayed"
  | "cancelled"
  | "failed"
  | "blocked"

export type DispatchResult = { outcome: DispatchOutcome; session?: BotSessionRecord }

function windowEnd(session: BotSessionRecord, config: BotConfig): number {
  const start = Date.parse(session.scheduledStart ?? session.createdAt)
  const end = session.scheduledEnd ? Date.parse(session.scheduledEnd) : undefined

  return joinWindowEnd(start, Number.isFinite(end) ? end : undefined, config.lateJoinMaxMinutes)
}

export async function scheduleDispatch(
  session: Pick<BotSession, "id" | "workspaceId" | "dispatchRev" | "dispatchAt">,
  deps: Partial<DispatchDeps> = {}
): Promise<void> {
  const { queue, now } = resolveDispatchDeps(deps)
  const at = session.dispatchAt ? Date.parse(session.dispatchAt) : now().getTime()

  await queue.enqueue(
    "bot.dispatch",
    { sessionId: session.id, rev: session.dispatchRev, workspaceId: session.workspaceId },
    {
      jobId: dispatchJobId(session.id, session.dispatchRev),
      delay: Math.max(0, (Number.isFinite(at) ? at : now().getTime()) - now().getTime()),
    }
  )
}

async function terminate(
  d: DispatchDeps,
  session: BotSessionRecord,
  status: Extract<BotStatus, "cancelled" | "failed" | "blocked">,
  reason: BotStatusReason,
  error?: unknown
): Promise<DispatchResult> {
  const result = await d.store.transition(session.id, {
    status,
    reason,
    at: d.now(),
    source: "api",
    workspaceId: session.workspaceId,
    event: { eventType: "dispatch", payload: { reason } },
  })
  let updated = result?.session

  if (error !== undefined) {
    updated = (await d.store.update(session.id, { error: redactBotError(error) }, { workspaceId: session.workspaceId })) ?? updated
  }
  botLog.info(`dispatch ${session.id}: ${status}/${reason}`)
  return { outcome: status, session: updated }
}

/** Re-delays a scheduled (or capacity-refused requested) session by 60 s via rev++. */
async function redelay(
  d: DispatchDeps,
  session: BotSessionRecord,
  rev: number,
  error?: unknown
): Promise<DispatchResult> {
  const next = d.now().getTime() + BOT_REDELAY_MS

  if (next > windowEnd(session, d.config)) return terminate(d, session, "failed", "capacity", error)

  const updated = await d.store.update(
    session.id,
    {
      status: "scheduled",
      statusReason: null,
      dispatchRev: rev + 1,
      dispatchAt: new Date(next).toISOString(),
      ...(error !== undefined ? { error: redactBotError(error) } : {}),
    },
    { expectedRev: rev, workspaceId: session.workspaceId }
  )

  if (!updated) return { outcome: "skipped" }
  await scheduleDispatch(updated, d)
  return { outcome: "redelayed", session: updated }
}

function buildRequest(d: DispatchDeps, session: BotSessionRecord): VexaBotRequest {
  const secrets = d.openSecrets(session.passcodeEnc)
  const language = session.language === "he" || session.language === "en" ? session.language : undefined
  const request: VexaBotRequest = {
    platform: session.platform,
    nativeMeetingId: session.nativeMeetingId,
    botName: ensureRecordingBotName(session.botName, session.language),
    transcribeEnabled: session.transcribeEnabled || d.config.transcribe || d.config.live.enabled,
    recordingEnabled: true,
    authenticated: d.config.authenticated,
    automaticLeave: { maxTimeLeftAloneMs: d.config.leftAloneMs },
    ...(language ? { language } : {}),
  }

  if (session.platform !== "google_meet") {
    const meetingUrl = rebuildCanonicalUrl(session.platform, session.meetingUrlRedacted, secrets)

    if (meetingUrl) request.meetingUrl = meetingUrl
    if (secrets.passcode) request.passcode = secrets.passcode
    if (session.teamsBaseHost) request.teamsBaseHost = session.teamsBaseHost
  }

  return request
}

/** Adopts a running Vexa bot for this target unless another session owns it. */
async function adopt(d: DispatchDeps, session: BotSessionRecord): Promise<BotSessionRecord | undefined> {
  const active = await d.provider().findActiveBot(session.platform, session.nativeMeetingId)

  if (!active?.vexaMeetingId) return undefined

  const owner = await d.store.findByVexaMeetingId(active.vexaMeetingId)

  if (owner && owner.id !== session.id) return undefined

  return d.store.update(
    session.id,
    { vexaMeetingId: active.vexaMeetingId, error: null },
    { workspaceId: session.workspaceId }
  )
}

async function request(d: DispatchDeps, session: BotSessionRecord, rev: number): Promise<DispatchResult> {
  try {
    const result = await d.provider().requestBot(buildRequest(d, session))
    const updated = result.vexaMeetingId
      ? await d.store.update(
          session.id,
          { vexaMeetingId: result.vexaMeetingId, error: null },
          { workspaceId: session.workspaceId }
        )
      : await d.store.get(session.id, { workspaceId: session.workspaceId })

    botLog.info(`dispatch ${session.id}: requested ${session.platform}`)
    return { outcome: "requested", session: updated }
  } catch (error) {
    if (!(error instanceof VexaError)) {
      await d.store.update(session.id, { error: redactBotError(error) }, { workspaceId: session.workspaceId })
      botLog.error(`dispatch ${session.id} failed`, error)
      throw error
    }

    switch (error.kind) {
      case "conflict": {
        const adopted = await adopt(d, session)

        return adopted
          ? { outcome: "adopted", session: adopted }
          : terminate(d, session, "blocked", "already_in_meeting")
      }
      case "capacity":
        return redelay(d, session, rev, error)
      case "invalid": {
        await terminate(d, session, "failed", "invalid_meeting_link", error)
        throw new UnrecoverableError(redactBotError(error))
      }
      case "config":
      case "auth":
        return error.code === "auth_session_missing"
          ? terminate(d, session, "blocked", "bot_signed_out", error)
          : terminate(d, session, "failed", "vexa_misconfigured", error)
      case "not_found":
      case "bad_response":
        return terminate(d, session, "failed", "vexa_unavailable", error)
      default:
        // unavailable / timeout / network: BullMQ retries (each retry adopts first).
        await d.store.update(session.id, { error: redactBotError(error) }, { workspaceId: session.workspaceId })
        botLog.error(`dispatch ${session.id} retryable`, error)
        throw error
    }
  }
}

export async function runDispatch(
  input: { sessionId: string; rev: number; workspaceId?: string },
  deps: Partial<DispatchDeps> = {}
): Promise<DispatchResult> {
  const d = resolveDispatchDeps(deps)
  const session = await d.store.withTransaction((tx) => d.store.getForUpdate(input.sessionId, tx))

  if (!session) return { outcome: "skipped" }
  if (input.workspaceId && session.workspaceId !== input.workspaceId) return { outcome: "skipped" }
  if (session.dispatchRev !== input.rev) return { outcome: "skipped", session }

  // A BullMQ retry after a retryable POST failure: adopt a bot that may exist.
  if (session.status === "requested" && !session.vexaMeetingId) {
    const adopted = await adopt(d, session)

    if (adopted) return { outcome: "adopted", session: adopted }
    return request(d, session, input.rev)
  }
  if (session.status !== "scheduled") return { outcome: "skipped", session }

  if (d.now().getTime() > windowEnd(session, d.config)) {
    return terminate(d, session, "cancelled", "missed_window")
  }

  const [live, workspaceLive] = await Promise.all([
    d.store.countLive(),
    d.store.countLive({ workspaceId: session.workspaceId }),
  ])

  if (live >= d.config.maxConcurrent || workspaceLive >= d.config.maxConcurrentPerWorkspace) {
    return redelay(d, session, input.rev)
  }

  const at = d.now()

  try {
    const marked = await d.store.transition(session.id, {
      status: "requested",
      reason: null,
      at,
      source: "api",
      workspaceId: session.workspaceId,
      event: { eventType: "dispatch", payload: { rev: input.rev } },
    })

    if (!marked?.applied) return { outcome: "skipped", session: marked?.session }
  } catch (error) {
    if (error instanceof BotSessionConflictError && error.constraint === "uq_bot_sessions_live_target") {
      return terminate(d, session, "blocked", "already_in_meeting")
    }
    throw error
  }

  const requested =
    (await d.store.update(
      session.id,
      { attempts: session.attempts + 1, requestedAt: at.toISOString() },
      { workspaceId: session.workspaceId }
    )) ?? session

  return request(d, requested, input.rev)
}

/**
 * Join now / Send bot: bumps the rev (invalidating any delayed job) and
 * enqueues an immediate dispatch. Non-scheduled sessions are returned as is.
 */
export async function dispatchNow(
  sessionId: string,
  deps: Partial<DispatchDeps> & { workspaceId?: string } = {}
): Promise<BotSession> {
  const d = resolveDispatchDeps(deps)
  const session = await d.store.get(sessionId, deps.workspaceId ? { workspaceId: deps.workspaceId } : {})

  if (!session) throw new Error("bot session not found")
  if (session.status !== "scheduled") return session

  const updated = await d.store.update(
    sessionId,
    { dispatchRev: session.dispatchRev + 1, dispatchAt: d.now().toISOString() },
    { expectedRev: session.dispatchRev, workspaceId: session.workspaceId }
  )

  if (!updated) return (await d.store.get(sessionId, { workspaceId: session.workspaceId })) ?? session

  await d.queue.remove(dispatchJobId(sessionId, session.dispatchRev)).catch(() => undefined)
  await scheduleDispatch(updated, d)
  return updated
}
