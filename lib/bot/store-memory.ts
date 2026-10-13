import {
  BotSessionConflictError,
  type BotEvent,
  type BotEventInput,
  type BotSessionCreateInput,
  type BotSessionPatch,
  type BotSessionStore,
  type BotStoreTx,
  type BotTransitionInput,
} from "@/lib/bot/store"
import {
  BOT_STATUS_RANK,
  type BotPlatform,
  type BotSessionRecord,
  type BotStatus,
  isLiveBotStatus,
  isTerminalBotStatus,
} from "@/lib/bot/types"
import { createId } from "@/lib/workspaces/tokens"

/**
 * In-memory BotSessionStore (M7 B, real). Mirrors the Postgres semantics the
 * tests rely on: the rank guard, the partial unique indexes
 * (live target, calendar event) and bot_events dedupe. Every method runs
 * synchronously before it resolves, so each call is atomic.
 */

const TX: BotStoreTx = Object.freeze({ kind: "bot_store_tx" as const })

function iso(value: Date | string): string {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString()
}

function time(value: string | null): number {
  return value ? Date.parse(value) : Number.NEGATIVE_INFINITY
}

function canTransition(from: BotStatus, to: BotStatus): boolean {
  if (isTerminalBotStatus(from)) return false

  const lateral =
    (from === "awaiting_admission" && to === "needs_help") ||
    (from === "needs_help" && to === "awaiting_admission")

  return lateral || BOT_STATUS_RANK[to] > BOT_STATUS_RANK[from]
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

  const copy = (session: BotSessionRecord): BotSessionRecord => structuredClone(session)

  function assertUnique(candidate: BotSessionRecord) {
    for (const other of sessions.values()) {
      if (other.id === candidate.id) continue

      if (
        isLiveBotStatus(candidate.status) &&
        isLiveBotStatus(other.status) &&
        other.platform === candidate.platform &&
        other.nativeMeetingId === candidate.nativeMeetingId
      ) {
        throw new BotSessionConflictError("uq_bot_sessions_live_target")
      }

      if (
        candidate.calendarEventId &&
        other.workspaceId === candidate.workspaceId &&
        other.calendarEventId === candidate.calendarEventId
      ) {
        throw new BotSessionConflictError("uq_bot_sessions_calendar")
      }
    }
  }

  function scoped(id: string, workspaceId?: string) {
    const session = sessions.get(id)

    if (!session) return undefined
    if (workspaceId && session.workspaceId !== workspaceId) return undefined
    return session
  }

  function insertEvent(input: BotEventInput): { duplicate: boolean; event?: BotEvent } {
    const vexaStatus = input.vexaStatus ?? null
    const duplicate = events.some(
      (event) =>
        (input.vexaEventId && event.vexaEventId === input.vexaEventId) ||
        (input.vexaMeetingId &&
          input.source === "webhook" &&
          event.source === "webhook" &&
          event.vexaMeetingId === input.vexaMeetingId &&
          event.eventType === input.eventType &&
          (event.vexaStatus ?? "") === (vexaStatus ?? ""))
    )

    if (duplicate) return { duplicate: true }

    const event: BotEvent = {
      id: createId("botevt"),
      botSessionId: input.botSessionId ?? null,
      workspaceId: input.workspaceId ?? null,
      source: input.source,
      vexaMeetingId: input.vexaMeetingId ?? null,
      vexaEventId: input.vexaEventId ?? null,
      eventType: input.eventType,
      vexaStatus,
      applied: input.applied ?? false,
      payload: structuredClone(input.payload ?? {}),
      receivedAt: input.receivedAt ?? now().toISOString(),
    }

    events.push(event)
    return { duplicate: false, event: structuredClone(event) }
  }

  const store: MemoryBotSessionStore = {
    sessions,
    events,

    async create(input: BotSessionCreateInput) {
      const stamp = now().toISOString()
      const status = input.status ?? "scheduled"
      const session: BotSessionRecord = {
        id: createId("bot"),
        workspaceId: input.workspaceId,
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

    async get(id, options = {}) {
      const session = scoped(id, options.workspaceId)

      return session ? copy(session) : undefined
    },

    async getForUpdate(id, tx) {
      void tx
      const session = sessions.get(id)

      return session ? copy(session) : undefined
    },

    async findByVexaMeetingId(vexaMeetingId) {
      const session = [...sessions.values()].find((item) => item.vexaMeetingId === vexaMeetingId)

      return session ? copy(session) : undefined
    },

    async findOpenByTarget(platform: BotPlatform, nativeMeetingId: string) {
      const session = [...sessions.values()]
        .filter(
          (item) =>
            item.platform === platform &&
            item.nativeMeetingId === nativeMeetingId &&
            !isTerminalBotStatus(item.status)
        )
        .sort((a, b) => time(b.createdAt) - time(a.createdAt))[0]

      return session ? copy(session) : undefined
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
        .filter(
          (item) =>
            item.recordingStatus === "imported" ||
            (isTerminalBotStatus(item.status) && item.recordingStatus !== "importing" &&
              item.recordingStatus !== "pending")
        )
        .map(copy)
    },

    async update(id, patch: BotSessionPatch, options = {}) {
      const session = scoped(id, options.workspaceId)

      if (!session) return undefined
      if (options.expectedRev !== undefined && session.dispatchRev !== options.expectedRev) {
        return undefined
      }

      const next: BotSessionRecord = {
        ...session,
        ...structuredClone(patch),
        updatedAt: now().toISOString(),
      }

      if (patch.status) next.statusRank = BOT_STATUS_RANK[patch.status]

      assertUnique(next)
      sessions.set(id, next)
      return copy(next)
    },

    async transition(id, input: BotTransitionInput) {
      const previous = scoped(id, input.workspaceId)

      if (!previous) return undefined

      const at = iso(input.at)
      const applied = canTransition(previous.status, input.status)
      let session = previous

      if (applied) {
        const next: BotSessionRecord = {
          ...previous,
          status: input.status,
          statusRank: BOT_STATUS_RANK[input.status],
          statusReason: input.reason ?? null,
          lastEventAt: at,
          updatedAt: now().toISOString(),
        }

        if (input.status === "active" && !previous.joinedAt) next.joinedAt = at
        if (isTerminalBotStatus(input.status) && !previous.leftAt) next.leftAt = at

        assertUnique(next)
        session = next
      } else {
        session = { ...previous, lastEventAt: at, updatedAt: now().toISOString() }
      }

      sessions.set(id, session)

      const event = input.event

      if (event?.eventId) {
        const recorded = events.find((item) => item.id === event.eventId)

        if (recorded) recorded.applied = applied
      } else {
        insertEvent({
          botSessionId: id,
          workspaceId: previous.workspaceId,
          source: input.source,
          eventType: event?.eventType ?? `status.${input.status}`,
          vexaMeetingId: event?.vexaMeetingId ?? previous.vexaMeetingId,
          vexaEventId: event?.vexaEventId ?? null,
          vexaStatus: event?.vexaStatus ?? null,
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

    async withTransaction(fn) {
      return fn(TX)
    },
  }

  return store
}
