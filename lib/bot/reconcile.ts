import { resyncWorkspaceBotSessions } from "@/lib/bot/calendar-sync"
import { type BotConfig, getBotConfig } from "@/lib/bot/config"
import { dispatchNow } from "@/lib/bot/dispatch"
import { applyVexaSnapshot, type BotSideEffect, runBotSideEffects } from "@/lib/bot/lifecycle"
import {
  defaultBotQueuePort,
  dispatchJobId,
  type BotQueuePort,
} from "@/lib/bot/queue"
import { botLog, redactBotError } from "@/lib/bot/redact"
import { type BotEventSource, type BotSessionStore, getBotSessionStore } from "@/lib/bot/store"
import { type BotSessionRecord, type BotStatusReason, isLiveBotStatus } from "@/lib/bot/types"
import { getBotProvider } from "@/lib/bot/vexa/client"
import { type BotProvider, type VexaMeeting, VexaError } from "@/lib/bot/vexa/types"

/**
 * Reconcile (M7 A9): the polling fallback when a webhook is missed. Runs every
 * MEETSUM_BOT_RECONCILE_SECONDS from a BullMQ job scheduler, or with
 * `{workspaceId, resyncRules:true}` after a rules change.
 */

/** A `requested` session without a Vexa meeting id after this long failed to start. */
export const REQUESTED_WITHOUT_ID_MS = 10 * 60_000
/** Completed sessions are checked for a missing finalize for this long. */
export const FINALIZE_LOOKBACK_MS = 24 * 60 * 60_000

export type ReconcileDeps = {
  store: BotSessionStore
  provider: () => BotProvider
  queue: BotQueuePort
  config: BotConfig
  now: () => Date
  applySnapshot: (
    store: BotSessionStore,
    session: BotSessionRecord,
    meeting: VexaMeeting,
    source: BotEventSource,
    options?: { at?: Date }
  ) => Promise<{ applied: boolean; session: BotSessionRecord; sideEffects: BotSideEffect[] }>
  resyncRules: (workspaceId: string) => Promise<unknown>
  dispatchNow: (sessionId: string, workspaceId: string) => Promise<unknown>
}

export function resolveReconcileDeps(deps: Partial<ReconcileDeps> = {}): ReconcileDeps {
  const store = deps.store ?? getBotSessionStore()
  const queue = deps.queue ?? defaultBotQueuePort
  const config = deps.config ?? getBotConfig()
  const provider = deps.provider ?? getBotProvider
  const now = deps.now ?? (() => new Date())

  return {
    store,
    provider,
    queue,
    config,
    now,
    applySnapshot: deps.applySnapshot ?? applyVexaSnapshot,
    resyncRules: deps.resyncRules ?? ((workspaceId) => resyncWorkspaceBotSessions(workspaceId)),
    dispatchNow:
      deps.dispatchNow ??
      ((sessionId, workspaceId) => dispatchNow(sessionId, { store, queue, config, now, provider, workspaceId })),
  }
}

/** Follow-up jobs through the shared lifecycle helper (same idempotent ids as the webhook). */
function sideEffects(
  d: ReconcileDeps,
  session: Pick<BotSessionRecord, "id" | "workspaceId">,
  effects: readonly BotSideEffect[]
) {
  return runBotSideEffects(session, effects, {
    enqueue: d.queue.enqueue,
    finalizeAttempts: d.config.finalizeAttempts,
  })
}

export type ReconcileStats = {
  dispatched: number
  polled: number
  stale: number
  unavailable: number
  notAdmitted: number
  meetingDeleted: number
  finalizeEnqueued: number
  resynced: boolean
  errors: string[]
}

function since(value: string | null, fallback: string): number {
  return Date.parse(value ?? fallback)
}

async function stopAndMark(
  d: ReconcileDeps,
  session: BotSessionRecord,
  status: "blocked" | "stopping",
  reason: BotStatusReason
) {
  try {
    await d.provider().stopBot(session.platform, session.nativeMeetingId)
  } catch (error) {
    // Already gone is fine; anything else is retried next tick.
    if (!(error instanceof VexaError && error.kind === "not_found")) throw error
  }

  return d.store.transition(session.id, {
    status,
    reason,
    at: d.now(),
    source: "poll",
    workspaceId: session.workspaceId,
    event: { eventType: "reconcile", payload: { reason } },
  })
}

export async function runBotReconcile(
  payload: { workspaceId?: string; resyncRules?: boolean } = {},
  deps: Partial<ReconcileDeps> = {}
): Promise<ReconcileStats> {
  const d = resolveReconcileDeps(deps)
  const stats: ReconcileStats = {
    dispatched: 0,
    polled: 0,
    stale: 0,
    unavailable: 0,
    notAdmitted: 0,
    meetingDeleted: 0,
    finalizeEnqueued: 0,
    resynced: false,
    errors: [],
  }
  const guard = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (error) {
      const message = `${label}: ${redactBotError(error)}`

      stats.errors.push(message)
      botLog.error(`reconcile ${message}`)
    }
  }

  // (f) Rules changed for one workspace.
  if (payload.resyncRules && payload.workspaceId) {
    await guard(`resync ${payload.workspaceId}`, async () => {
      await d.resyncRules(payload.workspaceId as string)
      stats.resynced = true
    })
    return stats
  }

  const now = d.now()
  const nowMs = now.getTime()

  // (a) Due scheduled sessions whose delayed job is gone.
  for (const session of await d.store.listDueForDispatch(now)) {
    await guard(`dispatch ${session.id}`, async () => {
      if (await d.queue.getJob(dispatchJobId(session.id, session.dispatchRev))) return
      await d.dispatchNow(session.id, session.workspaceId)
      stats.dispatched += 1
    })
  }

  const open = await d.store.listOpen()
  const staleBefore = nowMs - d.config.staleMinutes * 60_000
  const admissionBefore = nowMs - d.config.awaitingAdmissionTimeoutMinutes * 60_000

  for (const session of open) {
    if (session.status === "scheduled") continue

    await guard(`session ${session.id}`, async () => {
      // (d) The meeting was deleted under a live bot.
      if (session.meetingId === null && isLiveBotStatus(session.status)) {
        if (session.status !== "stopping") {
          await stopAndMark(d, session, "stopping", "meeting_deleted")
          stats.meetingDeleted += 1
        }
        return
      }

      // (c) Waiting in the lobby (either lobby status) for too long, measured
      // from when the session entered it: polls and repeated events that
      // change nothing never reset it.
      if (
        (session.status === "awaiting_admission" || session.status === "needs_help") &&
        since(session.statusChangedAt, session.updatedAt) < admissionBefore
      ) {
        await stopAndMark(d, session, "blocked", "not_admitted")
        stats.notAdmitted += 1
        return
      }

      // (b) No event for MEETSUM_BOT_STALE_MINUTES: poll Vexa.
      if (since(session.lastEventAt, session.updatedAt) >= staleBefore) return

      if (!session.vexaMeetingId) {
        if (
          session.status === "requested" &&
          since(session.requestedAt, session.updatedAt) < nowMs - REQUESTED_WITHOUT_ID_MS
        ) {
          await d.store.transition(session.id, {
            status: "failed",
            reason: "vexa_unavailable",
            at: now,
            source: "poll",
            workspaceId: session.workspaceId,
            event: { eventType: "reconcile", payload: { reason: "vexa_unavailable" } },
          })
          stats.unavailable += 1
        }
        // Stopped while its POST was in flight and no bot ever showed up: the
        // dispatcher had nothing to stop, so the session must not stay live.
        if (
          session.status === "stopping" &&
          since(session.statusChangedAt, session.updatedAt) < nowMs - REQUESTED_WITHOUT_ID_MS
        ) {
          await d.store.transition(session.id, {
            status: "cancelled",
            reason: session.statusReason ?? "user_stopped",
            at: now,
            source: "poll",
            workspaceId: session.workspaceId,
            event: { eventType: "reconcile", payload: { reason: "stopped_without_bot" } },
          })
        }
        return
      }

      let meeting: VexaMeeting

      try {
        meeting = await d.provider().getMeeting(session.vexaMeetingId)
      } catch (error) {
        if (error instanceof VexaError && error.kind === "not_found") {
          await d.store.transition(session.id, {
            status: "failed",
            reason: "stale",
            at: now,
            source: "poll",
            workspaceId: session.workspaceId,
            event: { eventType: "reconcile", payload: { reason: "stale" } },
          })
          stats.stale += 1
          return
        }
        throw error
      }

      const result = await d.applySnapshot(d.store, session, meeting, "poll", { at: now })

      stats.polled += 1
      await sideEffects(d, result.session, result.sideEffects)
    })
  }

  // (e) Completed with a recording expected but finalize never ran.
  const cutoff = new Date(nowMs - FINALIZE_LOOKBACK_MS)

  await guard("finalize sweep", async () => {
    // SYSTEM list across workspaces; each side effect is keyed to the row's own workspace.
    for (const session of await d.store.listCompletedWithoutFinalize(cutoff)) {
      await sideEffects(d, session, ["enqueue_finalize"])
      stats.finalizeEnqueued += 1
    }
  })

  return stats
}
