import { resyncWorkspaceBotSessions } from "@/lib/bot/calendar-sync"
import { type BotConfig, getBotConfig } from "@/lib/bot/config"
import { dispatchNow } from "@/lib/bot/dispatch"
import { applyVexaSnapshot, type BotSideEffect } from "@/lib/bot/lifecycle"
import {
  consentJobId,
  defaultBotQueuePort,
  dispatchJobId,
  finalizeJobId,
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
    source: BotEventSource
  ) => Promise<{ applied: boolean; session: BotSessionRecord; sideEffects: BotSideEffect[] }>
  resyncRules: (workspaceId: string) => Promise<unknown>
  dispatchNow: (sessionId: string, workspaceId: string) => Promise<unknown>
  /** Live workspaces (for the completed-without-finalize sweep). */
  listWorkspaceIds: () => Promise<string[]>
}

async function defaultWorkspaceIds(): Promise<string[]> {
  if (process.env.MEETSUM_STORAGE !== "postgres") {
    const { DEFAULT_WORKSPACE_ID } = await import("@/lib/workspaces/constants")

    return [DEFAULT_WORKSPACE_ID]
  }

  const { getDatabasePool } = await import("@/lib/db/client")
  const result = await getDatabasePool().query(
    `select distinct workspace_id from bot_sessions
      where status = 'completed' and recording_status = 'none' and updated_at > now() - interval '1 day'`
  )

  return (result.rows as Array<{ workspace_id: string }>).map((row) => row.workspace_id)
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
    listWorkspaceIds: deps.listWorkspaceIds ?? defaultWorkspaceIds,
  }
}

/** Enqueues finalize/consent side effects (shared with the webhook path). */
export async function runBotSideEffects(
  session: Pick<BotSessionRecord, "id" | "workspaceId">,
  effects: readonly BotSideEffect[],
  queue: BotQueuePort = defaultBotQueuePort,
  config: BotConfig = getBotConfig()
): Promise<void> {
  if (effects.includes("enqueue_finalize")) {
    await queue.enqueue(
      "bot.finalize",
      { sessionId: session.id, workspaceId: session.workspaceId },
      { jobId: finalizeJobId(session.id), attempts: config.finalizeAttempts }
    )
  }
  if (effects.includes("enqueue_consent")) {
    await queue.enqueue(
      "bot.consent",
      { sessionId: session.id, workspaceId: session.workspaceId },
      { jobId: consentJobId(session.id) }
    )
  }
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

      // (c) Waiting in the lobby for too long.
      if (
        session.status === "awaiting_admission" &&
        since(session.lastEventAt, session.updatedAt) < admissionBefore
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

      const result = await d.applySnapshot(d.store, session, meeting, "poll")

      stats.polled += 1
      await runBotSideEffects(result.session, result.sideEffects, d.queue, d.config)
    })
  }

  // (e) Completed with a recording expected but finalize never ran.
  const cutoff = new Date(nowMs - FINALIZE_LOOKBACK_MS)

  await guard("finalize sweep", async () => {
    for (const workspaceId of await d.listWorkspaceIds()) {
      for (const session of await d.store.listActive(workspaceId, { since: cutoff })) {
        if (
          session.status !== "completed" ||
          session.recordingStatus !== "none" ||
          !session.recordingEnabled ||
          !session.joinedAt
        ) {
          continue
        }

        await runBotSideEffects(session, ["enqueue_finalize"], d.queue, d.config)
        stats.finalizeEnqueued += 1
      }
    }
  })

  return stats
}
