import {
  BotSessionConflictError,
  type BotEvent,
  type BotEventInput,
  type BotSessionCreateInput,
  type BotSessionPatch,
  type BotSessionStore,
  type BotStoreTx,
  type BotTransitionInput,
  type BotUpdateOptions,
  type BotWebhookLookup,
} from "@/lib/bot/store"
import {
  BOT_STATUS_RANK,
  type BotSessionRecord,
  type BotStatus,
  isLiveBotStatus,
  isTerminalBotStatus,
} from "@/lib/bot/types"
import { createId } from "@/lib/workspaces/tokens"

/**
 * In-memory BotSessionStore (M7 B, real). Mirrors the Postgres semantics the
 * tests rely on: mandatory workspace scope, the rank guard, the
 * workspace-scoped partial unique indexes (live target, calendar event, Vexa
 * meeting id) and the workspace-scoped bot_events dedupe. Every method runs
 * synchronously before it resolves, so each call is atomic;
 * `withTransaction` callbacks are serialized (a stand-in for row locks).
 */

const TX: BotStoreTx = Object.freeze({ kind: "bot_store_tx" as const })

function iso(value: Date | string): string {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString()
}

function time(value: string | null): number {
  return value ? Date.parse(value) : Number.NEGATIVE_INFINITY
}

/** Rank guard (Model): higher rank only, lateral admission moves, terminal immutable. */
export function canTransitionBotStatus(from: BotStatus, to: BotStatus): boolean {
  if (isTerminalBotStatus(from)) return false

  const lateral =
    (from === "awaiting_admission" && to === "needs_help") ||
    (from === "needs_help" && to === "awaiting_admission")

  return lateral || BOT_STATUS_RANK[to] > BOT_STATUS_RANK[from]
}

/**
 * B6: the recording is imported, or the session is terminal with no
 * recording to import (a completed, recording-enabled session still waiting
 * for finalize is kept).
 */
export function isPurgeableBotSession(session: BotSessionRecord): boolean {
  if (session.recordingStatus === "imported") return true
  if (!isTerminalBotStatus(session.status)) return false
  if (session.recordingStatus === "missing" || session.recordingStatus === "failed") return true

  return (
    session.recordingStatus === "none" &&
    !(session.status === "completed" && session.recordingEnabled)
  )
}

function requireWorkspace(workspaceId: string | undefined): string {
  if (!workspaceId) throw new Error("bot store: workspaceId is required")
  return workspaceId
}

export type MemoryBotSessionStore = BotSessionStore & {
  /** Test helpers. */
  readonly sessions: Map<string, BotSessionRecord>
  readonly events: BotEvent[]
}

export function createMemoryBotSessionStore(
  options: { now?: () => Date } = {}
): MemoryBotSessionStore {
  const now = options.now ?? (() => new Date())
  const sessions = new Map<string, BotSessionRecord>()
  const events: BotEvent[] = []
  let lock: Promise<unknown> = Promise.resolve()

  const copy = (session: BotSessionRecord): BotSessionRecord => structuredClone(session)

  function assertUnique(candidate: BotSessionRecord) {
    for (const other of sessions.values()) {
      if (other.id === candidate.id || other.workspaceId !== candidate.workspaceId) continue

      if (
        isLiveBotStatus(candidate.status) &&
        isLiveBotStatus(other.status) &&
        other.platform === candidate.platform &&
        other.nativeMeetingId === candidate.nativeMeetingId
      ) {
        throw new BotSessionConflictError("uq_bot_sessions_ws_live_target")
      }

      if (candidate.calendarEventId && other.calendarEventId === candidate.calendarEventId) {
        throw new BotSessionConflictError("uq_bot_sessions_calendar")
      }

      if (candidate.vexaMeetingId && other.vexaMeetingId === candidate.vexaMeetingId) {
        throw new BotSessionConflictError("uq_bot_sessions_ws_vexa_meeting")
      }
    }
  }

  function scoped(id: string, workspaceId: string) {
    const session = sessions.get(id)

    if (!session || session.workspaceId !== requireWorkspace(workspaceId)) return undefined
    return session
  }

  function insertEvent(input: BotEventInput): { duplicate: boolean; event?: BotEvent } {
    const workspaceId = requireWorkspace(input.workspaceId)
    const vexaStatus = input.vexaStatus ?? null
    const prevStatus = input.prevStatus ?? null
    const duplicate = events.some(
      (event) =>
        event.workspaceId === workspaceId &&
        ((input.vexaEventId && event.vexaEventId === input.vexaEventId) ||
          (input.vexaMeetingId &&
            input.source === "webhook" &&
            event.source === "webhook" &&
            event.vexaMeetingId === input.vexaMeetingId &&
            event.eventType === input.eventType &&
            (event.vexaStatus ?? "") === (vexaStatus ?? "") &&
            (event.prevStatus ?? "") === (prevStatus ?? "")))
    )

    if (duplicate) return { duplicate: true }

    const event: BotEvent = {
      id: createId("botevt"),
      botSessionId: input.botSessionId ?? null,
      workspaceId,
      source: input.source,
      vexaMeetingId: input.vexaMeetingId ?? null,
      vexaEventId: input.vexaEventId ?? null,
      eventType: input.eventType,
      vexaStatus,
      prevStatus,
      applied: input.applied ?? false,
      payload: structuredClone(input.payload ?? {}),
      receivedAt: input.receivedAt ?? now().toISOString(),
    }

    events.push(event)
    return { duplicate: false, event: structuredClone(event) }
  }

  function newestOpenForTarget(lookup: BotWebhookLookup) {
    return [...sessions.values()]
      .filter(
        (item) =>
          item.platform === lookup.platform &&
          item.nativeMeetingId === lookup.nativeMeetingId &&
          !isTerminalBotStatus(item.status)
      )
      .sort((a, b) => time(b.createdAt) - time(a.createdAt))
  }

  const store: MemoryBotSessionStore = {
    sessions,
    events,

    async create(input: BotSessionCreateInput) {
      const stamp = now().toISOString()
      const status = input.status ?? "scheduled"
      const session: BotSessionRecord = {
        id: createId("bot"),
        workspaceId: requireWorkspace(input.workspaceId),
        meetingId: input.meetingId ?? null,
        origin: input.origin,
        platform: input.platform,
        nativeMeetingId: input.nativeMeetingId,
        meetingUrlRedacted: input.meetingUrlRedacted ?? null,
        passcodeEnc: input.passcodeEnc ?? null,
        teamsBaseHost: input.teamsBaseHost ?? null,
        vexaMeetingId: null,
        status,
        statusRank: BOT_STATUS_RANK[status],
        statusReason: input.statusReason ?? null,
        requestedByUserId: input.requestedByUserId ?? null,
        calendarEventId: input.calendarEventId ?? null,
        scheduledStart: input.scheduledStart ?? null,
        scheduledEnd: input.scheduledEnd ?? null,
        dispatchAt: input.dispatchAt ?? null,
        dispatchRev: 0,
        botName: input.botName,
        language: input.language ?? null,
        recordingEnabled: input.recordingEnabled ?? true,
        transcribeEnabled: input.transcribeEnabled ?? false,
        consentStatus: input.consentStatus ?? "pending",
        requestedAt: null,
        joinedAt: null,
        leftAt: null,
        lastEventAt: null,
        statusChangedAt: stamp,
        recordingStatus: "none",
        recordingStorageKey: null,
        mediaAssetId: null,
        ingestJobId: null,
        speakerTimeline: null,
        vexaPurgedAt: null,
        error: null,
        attempts: 0,
        createdAt: stamp,
        updatedAt: stamp,
      }

      assertUnique(session)
      sessions.set(session.id, session)
      return copy(session)
    },

    async get(id, scope) {
      const session = scoped(id, scope?.workspaceId)

      return session ? copy(session) : undefined
    },

    async getForUpdate(id, tx, scope) {
      void tx
      const session = scoped(id, scope?.workspaceId)

      return session ? copy(session) : undefined
    },

    async getForWebhook(lookup) {
      if (lookup.vexaMeetingId) {
        const matches = [...sessions.values()].filter(
          (item) => item.vexaMeetingId === lookup.vexaMeetingId
        )

        if (matches.length === 1) return copy(matches[0])
        if (matches.length > 1) return undefined
      }

      if (!lookup.platform || !lookup.nativeMeetingId) return undefined

      const open = newestOpenForTarget(lookup)

      // Never guess between workspaces: ambiguous targets resolve to nothing.
      if (new Set(open.map((item) => item.workspaceId)).size !== 1) return undefined
      return copy(open[0])
    },

    async findByCalendarEvent(workspaceId, calendarEventId) {
      const session = [...sessions.values()].find(
        (item) => item.workspaceId === workspaceId && item.calendarEventId === calendarEventId
      )

      return session ? copy(session) : undefined
    },

    async listForMeeting(workspaceId, meetingId) {
      return [...sessions.values()]
        .filter((item) => item.workspaceId === workspaceId && item.meetingId === meetingId)
        .sort((a, b) => time(b.createdAt) - time(a.createdAt))
        .map(copy)
    },

    async listActive(workspaceId, options = {}) {
      const meetingIds = options.meetingIds ? new Set(options.meetingIds) : undefined
      const since = options.since?.getTime()

      return [...sessions.values()]
        .filter((item) => item.workspaceId === workspaceId)
        .filter((item) => !meetingIds || (item.meetingId !== null && meetingIds.has(item.meetingId)))
        .filter(
          (item) =>
            !isTerminalBotStatus(item.status) ||
            (since !== undefined && time(item.updatedAt) >= since)
        )
        .sort((a, b) => time(b.createdAt) - time(a.createdAt))
        .map(copy)
    },

    async listOpen(options = {}) {
      const olderThan = options.olderThan?.getTime()

      return [...sessions.values()]
        .filter((item) => !isTerminalBotStatus(item.status))
        .filter(
          (item) =>
            olderThan === undefined || time(item.lastEventAt ?? item.updatedAt) < olderThan
        )
        .map(copy)
    },

    async listDueForDispatch(at) {
      return [...sessions.values()]
        .filter(
          (item) =>
            item.status === "scheduled" &&
            item.dispatchAt !== null &&
            time(item.dispatchAt) <= at.getTime()
        )
        .map(copy)
    },

    async listPurgeable(before) {
      const cutoff = before.getTime()

      return [...sessions.values()]
        .filter((item) => item.vexaMeetingId && !item.vexaPurgedAt)
        .filter((item) => time(item.updatedAt) < cutoff)
        .filter(isPurgeableBotSession)
        .map(copy)
    },

    async listCompletedWithoutFinalize(since) {
      const cutoff = since.getTime()

      return [...sessions.values()]
        .filter(
          (item) =>
            item.status === "completed" &&
            item.recordingStatus === "none" &&
            item.recordingEnabled &&
            item.joinedAt !== null &&
            time(item.updatedAt) >= cutoff
        )
        .map(copy)
    },

    async update(id, patch: BotSessionPatch, options: BotUpdateOptions) {
      const session = scoped(id, options?.workspaceId)

      if (!session) return undefined
      if (options.expectedRev !== undefined && session.dispatchRev !== options.expectedRev) {
        return undefined
      }

      const next: BotSessionRecord = {
        ...session,
        ...structuredClone(patch),
        updatedAt: now().toISOString(),
      }

      if (patch.status) {
        next.statusRank = BOT_STATUS_RANK[patch.status]
        if (patch.status !== session.status) next.statusChangedAt = next.updatedAt
      }

      assertUnique(next)
      sessions.set(id, next)
      return copy(next)
    },

    async transition(id, input: BotTransitionInput) {
      const previous = scoped(id, input.workspaceId)

      if (!previous) return undefined

      const at = iso(input.at)
      const applied = canTransitionBotStatus(previous.status, input.status)
      let session = previous

      if (applied) {
        const next: BotSessionRecord = {
          ...previous,
          status: input.status,
          statusRank: BOT_STATUS_RANK[input.status],
          statusReason: input.reason ?? null,
          lastEventAt: at,
          statusChangedAt: at,
          updatedAt: now().toISOString(),
        }

        if (input.status === "active" && !previous.joinedAt) next.joinedAt = at
        if (isTerminalBotStatus(input.status) && !previous.leftAt) next.leftAt = at
        if (isTerminalBotStatus(input.status)) next.passcodeEnc = null

        assertUnique(next)
        session = next
      } else if (input.source !== "poll") {
        // A delivered (webhook/api) event is still a sign of life. A no-op
        // poll is not: it must not push back stale/lobby checks.
        session = { ...previous, lastEventAt: at, updatedAt: now().toISOString() }
      }

      sessions.set(id, session)

      const event = input.event

      if (event?.eventId) {
        const recorded = events.find(
          (item) => item.id === event.eventId && item.workspaceId === previous.workspaceId
        )

        if (recorded) {
          recorded.applied = applied
          recorded.botSessionId = id
        }
      } else {
        insertEvent({
          botSessionId: id,
          workspaceId: previous.workspaceId,
          source: input.source,
          eventType: event?.eventType ?? `status.${input.status}`,
          vexaMeetingId: event?.vexaMeetingId ?? previous.vexaMeetingId,
          vexaEventId: event?.vexaEventId ?? null,
          vexaStatus: event?.vexaStatus ?? null,
          prevStatus: previous.status,
          applied,
          payload: event?.payload ?? {},
          receivedAt: at,
        })
      }

      return { applied, session: copy(session), previous: copy(previous) }
    },

    async countLive(options = {}) {
      return [...sessions.values()].filter(
        (item) =>
          isLiveBotStatus(item.status) &&
          (!options.workspaceId || item.workspaceId === options.workspaceId)
      ).length
    },

    async countCreatedSince(workspaceId, since) {
      return [...sessions.values()].filter(
        (item) => item.workspaceId === workspaceId && time(item.createdAt) >= since.getTime()
      ).length
    },

    async recordEvent(input) {
      return insertEvent(input)
    },

    async deleteEvent(id, scope) {
      const workspaceId = requireWorkspace(scope?.workspaceId)
      const index = events.findIndex((event) => event.id === id && event.workspaceId === workspaceId)

      if (index >= 0) events.splice(index, 1)
    },

    async clearTerminalPasscodes() {
      let cleared = 0

      for (const [id, session] of sessions) {
        if (session.passcodeEnc !== null && isTerminalBotStatus(session.status)) {
          sessions.set(id, { ...session, passcodeEnc: null })
          cleared += 1
        }
      }

      return cleared
    },

    async pruneEventPayloads(before) {
      let pruned = 0

      for (const event of events) {
        if (time(event.receivedAt) < before.getTime() && Object.keys(event.payload).length) {
          event.payload = {}
          pruned += 1
        }
      }

      return pruned
    },

    async withTransaction(fn) {
      const run = lock.then(() => fn(TX))

      lock = run.catch(() => undefined)
      return run
    },
  }

  return store
}
