import { canTransitionBotStatus } from "@/lib/bot/store-memory"
import {
  BOT_SESSION_UNIQUE_CONSTRAINTS,
  BotSessionConflictError,
  type BotEvent,
  type BotEventInput,
  type BotEventSource,
  type BotSessionPatch,
  type BotSessionStore,
  type BotSessionUniqueConstraint,
  type BotStoreTx,
} from "@/lib/bot/store"
import {
  BOT_STATUS_RANK,
  LIVE_BOT_STATUSES,
  TERMINAL_BOT_STATUSES,
  isTerminalBotStatus,
  type BotSessionRecord,
} from "@/lib/bot/types"
import type { Queryable } from "@/lib/db/client"
import { createId } from "@/lib/workspaces/tokens"

/**
 * Postgres BotSessionStore (M7 B1).
 *
 * Every per-session statement carries `workspace_id = $n`; the only
 * unscoped reads are the explicitly named system lookups (`getForWebhook`
 * and the instance-wide worker lists), which return rows with their own
 * workspace. `transition` is one transaction: `select ... for update`, the
 * rank check, `update`, then the bot_events insert (or applied flag).
 */

type Row = Record<string, unknown>

type PoolLike = Queryable & {
  connect?: () => Promise<Queryable & { release: () => void }>
}

const LIVE_SQL = LIVE_BOT_STATUSES.map((status) => `'${status}'`).join(",")
const TERMINAL_SQL = TERMINAL_BOT_STATUSES.map((status) => `'${status}'`).join(",")

const SESSION_COLUMNS: Record<string, string> = {
  meetingId: "meeting_id",
  meetingUrlRedacted: "meeting_url_redacted",
  passcodeEnc: "passcode_enc",
  teamsBaseHost: "teams_base_host",
  vexaMeetingId: "vexa_meeting_id",
  scheduledStart: "scheduled_start",
  scheduledEnd: "scheduled_end",
  dispatchAt: "dispatch_at",
  dispatchRev: "dispatch_rev",
  botName: "bot_name",
  language: "language",
  recordingEnabled: "recording_enabled",
  transcribeEnabled: "transcribe_enabled",
  consentStatus: "consent_status",
  requestedAt: "requested_at",
  recordingStatus: "recording_status",
  recordingStorageKey: "recording_storage_key",
  mediaAssetId: "media_asset_id",
  ingestJobId: "ingest_job_id",
  speakerTimeline: "speaker_timeline",
  vexaPurgedAt: "vexa_purged_at",
  error: "error",
  attempts: "attempts",
  lastEventAt: "last_event_at",
  status: "status",
  statusReason: "status_reason",
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function timestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return new Date(String(value)).toISOString()
}

function json(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null

  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function rowToBotSession(row: Row): BotSessionRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    meetingId: text(row.meeting_id),
    origin: row.origin as BotSessionRecord["origin"],
    platform: row.platform as BotSessionRecord["platform"],
    nativeMeetingId: String(row.native_meeting_id),
    meetingUrlRedacted: text(row.meeting_url_redacted),
    passcodeEnc: text(row.passcode_enc),
    teamsBaseHost: text(row.teams_base_host),
    vexaMeetingId: text(row.vexa_meeting_id),
    status: row.status as BotSessionRecord["status"],
    statusRank: Number(row.status_rank ?? 0),
    statusReason: text(row.status_reason) as BotSessionRecord["statusReason"],
    requestedByUserId: text(row.requested_by_user_id),
    calendarEventId: text(row.calendar_event_id),
    scheduledStart: timestamp(row.scheduled_start),
    scheduledEnd: timestamp(row.scheduled_end),
    dispatchAt: timestamp(row.dispatch_at),
    dispatchRev: Number(row.dispatch_rev ?? 0),
    botName: String(row.bot_name ?? ""),
    language: text(row.language),
    recordingEnabled: row.recording_enabled !== false,
    transcribeEnabled: row.transcribe_enabled === true,
    consentStatus: (text(row.consent_status) ?? "pending") as BotSessionRecord["consentStatus"],
    requestedAt: timestamp(row.requested_at),
    joinedAt: timestamp(row.joined_at),
    leftAt: timestamp(row.left_at),
    lastEventAt: timestamp(row.last_event_at),
    recordingStatus: (text(row.recording_status) ?? "none") as BotSessionRecord["recordingStatus"],
    recordingStorageKey: text(row.recording_storage_key),
    mediaAssetId: text(row.media_asset_id),
    ingestJobId: text(row.ingest_job_id),
    speakerTimeline: json(row.speaker_timeline),
    vexaPurgedAt: timestamp(row.vexa_purged_at),
    error: text(row.error),
    attempts: Number(row.attempts ?? 0),
    createdAt: timestamp(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: timestamp(row.updated_at) ?? new Date(0).toISOString(),
  }
}

function rowToBotEvent(row: Row): BotEvent {
  const payload = json(row.payload)

  return {
    id: String(row.id),
    botSessionId: text(row.bot_session_id),
    workspaceId: text(row.workspace_id),
    source: row.source as BotEventSource,
    vexaMeetingId: text(row.vexa_meeting_id),
    vexaEventId: text(row.vexa_event_id),
    eventType: String(row.event_type),
    vexaStatus: text(row.vexa_status),
    applied: row.applied === true,
    payload: payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {},
    receivedAt: timestamp(row.received_at) ?? new Date(0).toISOString(),
  }
}

/** Maps a pg unique violation on a bot_sessions index to BotSessionConflictError. */
function conflictFrom(error: unknown): BotSessionConflictError | undefined {
  const candidate = error as { code?: string; constraint?: string } | undefined

  if (candidate?.code !== "23505") return undefined

  const constraint = BOT_SESSION_UNIQUE_CONSTRAINTS.find(
    (name) => name === candidate.constraint
  ) as BotSessionUniqueConstraint | undefined

  return constraint ? new BotSessionConflictError(constraint) : undefined
}

function serializeColumn(key: string, value: unknown): unknown {
  if (key === "speakerTimeline") return value === null || value === undefined ? null : JSON.stringify(value)
  return value ?? null
}

function requireWorkspace(workspaceId: string | undefined): string {
  if (!workspaceId) throw new Error("bot store: workspaceId is required")
  return workspaceId
}

export function createPostgresBotSessionStore(db: Queryable): BotSessionStore {
  const clients = new WeakMap<BotStoreTx, Queryable>()

  function clientOf(tx?: BotStoreTx): Queryable {
    return (tx && clients.get(tx)) || db
  }

  async function inTransaction<T>(fn: (tx: BotStoreTx) => Promise<T>): Promise<T> {
    const pool = db as PoolLike
    const connection = typeof pool.connect === "function" ? await pool.connect() : undefined
    const client: Queryable = connection ?? db
    const tx: BotStoreTx = Object.freeze({ kind: "bot_store_tx" as const })

    clients.set(tx, client)

    try {
      await client.query("begin")
      const result = await fn(tx)
      await client.query("commit")
      return result
    } catch (error) {
      await client.query("rollback").catch(() => undefined)
      throw error
    } finally {
      clients.delete(tx)
      connection?.release()
    }
  }

  async function many(client: Queryable, sql: string, values: unknown[]) {
    const result = await client.query(sql, values)

    return (result.rows as Row[]).map(rowToBotSession)
  }

  async function one(client: Queryable, sql: string, values: unknown[]) {
    return (await many(client, sql, values))[0]
  }

  async function insertEvent(
    client: Queryable,
    input: BotEventInput
  ): Promise<{ duplicate: boolean; event?: BotEvent }> {
    const result = await client.query(
      `insert into bot_events (
         id, bot_session_id, workspace_id, source, vexa_meeting_id, vexa_event_id,
         event_type, vexa_status, applied, payload, received_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, coalesce($11::timestamptz, now()))
       on conflict do nothing
       returning *`,
      [
        createId("botevt"),
        input.botSessionId ?? null,
        requireWorkspace(input.workspaceId),
        input.source,
        input.vexaMeetingId ?? null,
        input.vexaEventId ?? null,
        input.eventType,
        input.vexaStatus ?? null,
        input.applied ?? false,
        JSON.stringify(input.payload ?? {}),
        input.receivedAt ?? null,
      ]
    )
    const row = (result.rows as Row[])[0]

    return row ? { duplicate: false, event: rowToBotEvent(row) } : { duplicate: true }
  }

  const store: BotSessionStore = {
    async create(input) {
      const status = input.status ?? "scheduled"

      try {
        const created = await one(
          db,
          `insert into bot_sessions (
             id, workspace_id, meeting_id, origin, platform, native_meeting_id,
             meeting_url_redacted, passcode_enc, teams_base_host, status, status_rank,
             status_reason, requested_by_user_id, calendar_event_id, scheduled_start,
             scheduled_end, dispatch_at, bot_name, language, recording_enabled,
             transcribe_enabled, consent_status
           )
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19, $20, $21, $22)
           returning *`,
          [
            createId("bot"),
            requireWorkspace(input.workspaceId),
            input.meetingId ?? null,
            input.origin,
            input.platform,
            input.nativeMeetingId,
            input.meetingUrlRedacted ?? null,
            input.passcodeEnc ?? null,
            input.teamsBaseHost ?? null,
            status,
            BOT_STATUS_RANK[status],
            input.statusReason ?? null,
            input.requestedByUserId ?? null,
            input.calendarEventId ?? null,
            input.scheduledStart ?? null,
            input.scheduledEnd ?? null,
            input.dispatchAt ?? null,
            input.botName,
            input.language ?? null,
            input.recordingEnabled ?? true,
            input.transcribeEnabled ?? false,
            input.consentStatus ?? "pending",
          ]
        )

        if (!created) throw new Error("bot session insert returned no row")
        return created
      } catch (error) {
        throw conflictFrom(error) ?? error
      }
    },

    async get(id, scope) {
      return one(db, `select * from bot_sessions where id = $1 and workspace_id = $2`, [
        id,
        requireWorkspace(scope?.workspaceId),
      ])
    },

    async getForUpdate(id, tx, scope) {
      return one(
        clientOf(tx),
        `select * from bot_sessions where id = $1 and workspace_id = $2 for update`,
        [id, requireWorkspace(scope?.workspaceId)]
      )
    },

    async getForWebhook(lookup) {
      if (lookup.vexaMeetingId) {
        const matches = await many(
          db,
          `select * from bot_sessions where vexa_meeting_id = $1 limit 2`,
          [lookup.vexaMeetingId]
        )

        if (matches.length === 1) return matches[0]
        if (matches.length > 1) return undefined
      }

      if (!lookup.platform || !lookup.nativeMeetingId) return undefined

      const open = await many(
        db,
        `select * from bot_sessions
         where platform = $1 and native_meeting_id = $2
           and status not in (${TERMINAL_SQL})
         order by created_at desc
         limit 20`,
        [lookup.platform, lookup.nativeMeetingId]
      )

      // Never guess between workspaces: ambiguous targets resolve to nothing.
      if (new Set(open.map((session) => session.workspaceId)).size !== 1) return undefined
      return open[0]
    },

    async findByCalendarEvent(workspaceId, calendarEventId) {
      return one(
        db,
        `select * from bot_sessions where workspace_id = $1 and calendar_event_id = $2 limit 1`,
        [requireWorkspace(workspaceId), calendarEventId]
      )
    },

    async listForMeeting(workspaceId, meetingId) {
      return many(
        db,
        `select * from bot_sessions where workspace_id = $1 and meeting_id = $2
         order by created_at desc limit 50`,
        [requireWorkspace(workspaceId), meetingId]
      )
    },

    async listActive(workspaceId, options = {}) {
      const values: unknown[] = [requireWorkspace(workspaceId)]
      const filters = ["workspace_id = $1"]

      if (options.meetingIds) {
        values.push(options.meetingIds)
        filters.push(`meeting_id = any($${values.length}::text[])`)
      }

      if (options.since) {
        values.push(options.since.toISOString())
        filters.push(`(status not in (${TERMINAL_SQL}) or updated_at >= $${values.length})`)
      } else {
        filters.push(`status not in (${TERMINAL_SQL})`)
      }

      return many(
        db,
        `select * from bot_sessions where ${filters.join(" and ")}
         order by created_at desc limit 500`,
        values
      )
    },

    async listOpen(options = {}) {
      const values: unknown[] = []
      let filter = ""

      if (options.olderThan) {
        values.push(options.olderThan.toISOString())
        filter = ` and coalesce(last_event_at, updated_at) < $1`
      }

      return many(
        db,
        `select * from bot_sessions where status not in (${TERMINAL_SQL})${filter}
         order by updated_at asc limit 500`,
        values
      )
    },

    async listDueForDispatch(now) {
      return many(
        db,
        `select * from bot_sessions
         where status = 'scheduled' and dispatch_at is not null and dispatch_at <= $1
         order by dispatch_at asc limit 200`,
        [now.toISOString()]
      )
    },

    async listPurgeable(before) {
      return many(
        db,
        `select * from bot_sessions
         where vexa_meeting_id is not null and vexa_purged_at is null and updated_at < $1
           and (
             recording_status = 'imported'
             or (status in (${TERMINAL_SQL}) and (
               recording_status in ('missing','failed')
               or (recording_status = 'none'
                   and not (status = 'completed' and recording_enabled))
             ))
           )
         order by updated_at asc limit 200`,
        [before.toISOString()]
      )
    },

    async listCompletedWithoutFinalize(since) {
      return many(
        db,
        `select * from bot_sessions
         where status = 'completed' and recording_status = 'none'
           and recording_enabled and joined_at is not null and updated_at >= $1
         order by updated_at asc limit 200`,
        [since.toISOString()]
      )
    },

    async update(id, patch: BotSessionPatch, options) {
      const workspaceId = requireWorkspace(options?.workspaceId)
      const values: unknown[] = [id, workspaceId]
      const sets: string[] = []

      for (const [key, value] of Object.entries(patch)) {
        const column = SESSION_COLUMNS[key]

        if (!column || value === undefined) continue

        values.push(serializeColumn(key, value))
        sets.push(
          `${column} = $${values.length}${key === "speakerTimeline" ? "::jsonb" : ""}`
        )

        if (key === "status") {
          values.push(BOT_STATUS_RANK[value as BotSessionRecord["status"]])
          sets.push(`status_rank = $${values.length}`)
        }
      }

      sets.push("updated_at = now()")

      let rev = ""

      if (options.expectedRev !== undefined) {
        values.push(options.expectedRev)
        rev = ` and dispatch_rev = $${values.length}`
      }

      try {
        return await one(
          clientOf(options.tx),
          `update bot_sessions set ${sets.join(", ")}
           where id = $1 and workspace_id = $2${rev}
           returning *`,
          values
        )
      } catch (error) {
        throw conflictFrom(error) ?? error
      }
    },

    async transition(id, input) {
      const workspaceId = requireWorkspace(input.workspaceId)
      const at = typeof input.at === "string" ? new Date(input.at).toISOString() : input.at.toISOString()

      try {
        return await inTransaction(async (tx) => {
          const client = clientOf(tx)
          const previous = await one(
            client,
            `select * from bot_sessions where id = $1 and workspace_id = $2 for update`,
            [id, workspaceId]
          )

          if (!previous) return undefined

          const applied = canTransitionBotStatus(previous.status, input.status)
          const session = applied
            ? await one(
                client,
                `update bot_sessions set
                   status = $3,
                   status_rank = $4,
                   status_reason = $5,
                   last_event_at = $6,
                   joined_at = case when $3 = 'active' then coalesce(joined_at, $6) else joined_at end,
                   left_at = case when $7 then coalesce(left_at, $6) else left_at end,
                   updated_at = now()
                 where id = $1 and workspace_id = $2
                 returning *`,
                [
                  id,
                  workspaceId,
                  input.status,
                  BOT_STATUS_RANK[input.status],
                  input.reason ?? null,
                  at,
                  isTerminalBotStatus(input.status),
                ]
              )
            : await one(
                client,
                `update bot_sessions set last_event_at = $3, updated_at = now()
                 where id = $1 and workspace_id = $2
                 returning *`,
                [id, workspaceId, at]
              )

          const event = input.event

          if (event?.eventId) {
            await client.query(
              `update bot_events set applied = $3, bot_session_id = $4
               where id = $1 and workspace_id = $2`,
              [event.eventId, workspaceId, applied, id]
            )
          } else {
            await insertEvent(client, {
              botSessionId: id,
              workspaceId,
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

          return { applied, session: session ?? previous, previous }
        })
      } catch (error) {
        throw conflictFrom(error) ?? error
      }
    },

    async countLive(options = {}) {
      const values: unknown[] = []
      let filter = ""

      if (options.workspaceId) {
        values.push(options.workspaceId)
        filter = " and workspace_id = $1"
      }

      const result = await db.query(
        `select count(*)::int as count from bot_sessions where status in (${LIVE_SQL})${filter}`,
        values
      )

      return Number((result.rows[0] as Row | undefined)?.count ?? 0)
    },

    async countCreatedSince(workspaceId, since) {
      const result = await db.query(
        `select count(*)::int as count from bot_sessions
         where workspace_id = $1 and created_at >= $2`,
        [requireWorkspace(workspaceId), since.toISOString()]
      )

      return Number((result.rows[0] as Row | undefined)?.count ?? 0)
    },

    async recordEvent(input) {
      return insertEvent(db, input)
    },

    async pruneEventPayloads(before) {
      const result = await db.query(
        `update bot_events set payload = '{}'::jsonb
         where received_at < $1 and payload <> '{}'::jsonb
         returning id`,
        [before.toISOString()]
      )

      return result.rows.length
    },

    withTransaction: inTransaction,
  }

  return store
}
