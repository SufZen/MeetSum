/**
 * Cross-meeting task list over visible meetings (docs/parity/m5.md B6;
 * owner: Package B).
 *
 * Postgres joins `action_items` to `meetings` under the M2 scope predicate,
 * so a task is listed only while its meeting is visible to the caller. The
 * in-memory backend (demo storage) filters the scoped repository's meetings
 * with the same rules (`filterTasks`).
 *
 * Sort: due date ascending (no date last), then newest first; keyset cursor
 * over `(due_on, created_at, id)`; at most 100 per page.
 */
import type { Queryable } from "@/lib/db/client"
import { actionItemColumns, mapTaskActionItemRow } from "@/lib/meetings/postgres-repository"
import type {
  ActionItem,
  MeetingRecord,
  MeetingRepository,
  RepoScope,
} from "@/lib/meetings/repository"
import { meetingScopeSql } from "@/lib/meetings/scope-sql"
import { localDateIn } from "@/lib/tasks/due-date"
import { getTaskTimeZone } from "@/lib/tasks/time-zone"
import type { TaskListPage, TaskListQuery, TaskRow } from "@/lib/tasks/types"

export const TASKS_DEFAULT_LIMIT = 50
export const TASKS_MAX_LIMIT = 100

export type TaskStoreOptions = {
  /** Clock for "overdue" (tests). */
  now?: Date
  timeZone?: string
}

type Cursor = { d: string | null; c: string; i: string }

export class InvalidTaskCursorError extends Error {
  constructor() {
    super("Invalid cursor")
    this.name = "InvalidTaskCursorError"
  }
}

export function encodeTaskCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
}

/** A timestamp Postgres accepts as timestamptz (ISO or `YYYY-MM-DD HH:MM:SS[.ffffff]+TZ`). */
const CURSOR_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[T ]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)?$/
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

function isCursorTimestamp(value: string): boolean {
  return CURSOR_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value))
}

/** A real calendar date (`2026-02-30` is rejected, like Postgres). */
function isCursorDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false

  const date = new Date(`${value}T00:00:00.000Z`)

  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/**
 * Decodes a keyset cursor. `c` (timestamp) and `d` (date-only) reach the SQL
 * as typed parameters, so they are validated here: a tampered cursor is an
 * InvalidTaskCursorError (400), never a Postgres 22007 (500).
 */
export function decodeTaskCursor(value: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed.d === null || (typeof parsed.d === "string" && isCursorDate(parsed.d))) &&
      typeof parsed.c === "string" &&
      isCursorTimestamp(parsed.c) &&
      typeof parsed.i === "string"
    ) {
      return parsed
    }
  } catch {
    // fall through
  }

  throw new InvalidTaskCursorError()
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return TASKS_DEFAULT_LIMIT

  return Math.max(1, Math.min(Math.trunc(limit), TASKS_MAX_LIMIT))
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function today(options: TaskStoreOptions): string {
  return localDateIn(options.now ?? new Date(), options.timeZone ?? getTaskTimeZone())
}

type TaskSqlRow = Record<string, unknown> & {
  meeting_title: string
  meeting_language?: string | null
  meeting_started_at: string | Date
  cursor_created_at: string
}

/** The SQL and values of one page (exported for the recording tests). */
export function buildTaskListSql(
  scope: RepoScope,
  query: TaskListQuery,
  options: TaskStoreOptions = {}
): { text: string; values: unknown[]; limit: number } {
  const values: unknown[] = []
  const param = (value: unknown) => {
    values.push(value)
    return `$${values.length}`
  }
  // The visibility predicate first: no task query runs without it.
  const clauses: string[] = [meetingScopeSql(scope, "m", values)]

  clauses.push(`ai.workspace_id = ${param(scope.workspaceId)}`)

  if (query.scope === "mine") {
    if (scope.kind === "member") {
      const me = param(scope.userId)
      const email = param(scope.email.trim().toLowerCase())

      clauses.push(
        `(ai.owner_user_id = ${me}` +
          ` or exists (select 1 from meeting_participants mp_owner where mp_owner.id = ai.owner_participant_id and mp_owner.meeting_id = ai.meeting_id and lower(mp_owner.email) = ${email})` +
          ` or (ai.created_by_user_id = ${me} and ai.owner_user_id is null and ai.owner_participant_id is null and coalesce(ai.owner_text, '') = ''))`
      )
    } else if (scope.kind === "api_key" && scope.ownerUserId) {
      clauses.push(`ai.owner_user_id = ${param(scope.ownerUserId)}`)
    } else {
      clauses.push("false")
    }
  }

  if (query.status === "open") clauses.push("ai.status = 'open'")
  if (query.status === "done") clauses.push("ai.status = 'done'")
  if (query.status === "overdue") {
    clauses.push(`ai.status = 'open' and ai.due_on < ${param(today(options))}::date`)
  }

  if (query.roomId) {
    const room = param(query.roomId)
    const ws = param(scope.workspaceId)

    clauses.push(
      `exists (select 1 from meeting_contexts mc join contexts c on c.id = mc.context_id where mc.meeting_id = m.id and mc.context_id = ${room} and c.workspace_id = ${ws})`
    )
  }
  if (query.meetingId) clauses.push(`ai.meeting_id = ${param(query.meetingId)}`)
  if (query.ownerUserId) clauses.push(`ai.owner_user_id = ${param(query.ownerUserId)}`)
  if (query.dueFrom) clauses.push(`ai.due_on >= ${param(query.dueFrom)}::date`)
  if (query.dueTo) clauses.push(`ai.due_on <= ${param(query.dueTo)}::date`)
  if (query.q?.trim()) clauses.push(`ai.title ilike ${param(`%${escapeLike(query.q.trim())}%`)}`)

  const byCreated = query.sort === "created"

  if (query.cursor) {
    const cursor = decodeTaskCursor(query.cursor)
    const c = param(cursor.c)
    const i = param(cursor.i)
    const newer = `(ai.created_at < ${c}::timestamptz or (ai.created_at = ${c}::timestamptz and ai.id < ${i}))`

    if (byCreated) {
      clauses.push(newer)
    } else if (cursor.d === null) {
      clauses.push(`(ai.due_on is null and ${newer})`)
    } else {
      const d = param(cursor.d)

      clauses.push(
        `(ai.due_on > ${d}::date or (ai.due_on = ${d}::date and ${newer}) or ai.due_on is null)`
      )
    }
  }

  const limit = clampLimit(query.limit)
  const order = byCreated
    ? "ai.created_at desc, ai.id desc"
    : "ai.due_on asc nulls last, ai.created_at desc, ai.id desc"

  return {
    text: `
      select ${actionItemColumns("ai")},
             ai.created_at::text as cursor_created_at,
             m.title as meeting_title,
             m.language as meeting_language,
             m.started_at as meeting_started_at
      from action_items ai
      join meetings m on m.id = ai.meeting_id
      where ${clauses.join("\n        and ")}
      order by ${order}
      limit ${param(limit + 1)}
    `,
    values,
    limit,
  }
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value
}

/** Postgres task list (`listTasks` for `MEETSUM_STORAGE=postgres`). */
export async function listTasksPostgres(
  client: Queryable,
  scope: RepoScope,
  query: TaskListQuery,
  options: TaskStoreOptions = {}
): Promise<TaskListPage> {
  const { text, values, limit } = buildTaskListSql(scope, query, options)
  const result = await client.query(text, values)
  const rows = result.rows as TaskSqlRow[]
  const page = rows.slice(0, limit)
  const tasks: TaskRow[] = page.map((row) => {
    const item = mapTaskActionItemRow(row)

    return {
      ...item,
      meeting: {
        id: item.meetingId ?? String(row.meeting_id),
        title: row.meeting_title,
        startedAt: toIso(row.meeting_started_at),
        language: row.meeting_language ?? undefined,
      },
    }
  })
  const last = page.at(-1)
  const lastTask = tasks.at(-1)

  return {
    tasks,
    nextCursor:
      rows.length > limit && last && lastTask
        ? encodeTaskCursor({ d: lastTask.dueOn ?? null, c: last.cursor_created_at, i: lastTask.id })
        : undefined,
  }
}

// ---------------------------------------------------------------------------
// In-memory (demo storage): the same filters over visible meetings.

export type MemoryTaskMeeting = Pick<MeetingRecord, "id" | "title" | "startedAt" | "summary" | "contexts" | "language" | "languageMetadata"> & {
  participantDetails?: MeetingRecord["participantDetails"]
}

function compareTasks(a: TaskRow, b: TaskRow, byCreated: boolean): number {
  if (!byCreated) {
    if (a.dueOn !== b.dueOn) {
      if (!a.dueOn) return 1
      if (!b.dueOn) return -1
      return a.dueOn < b.dueOn ? -1 : 1
    }
  }

  const ac = a.createdAt ?? ""
  const bc = b.createdAt ?? ""

  if (ac !== bc) return ac < bc ? 1 : -1
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

function isMine(scope: RepoScope, meeting: MemoryTaskMeeting, item: ActionItem): boolean {
  if (scope.kind === "member") {
    const email = scope.email.trim().toLowerCase()
    const participant = item.ownerParticipantId
      ? meeting.participantDetails?.find((candidate) => candidate.id === item.ownerParticipantId)
      : undefined

    return (
      item.ownerUserId === scope.userId ||
      (participant?.email?.trim().toLowerCase() === email && email.length > 0) ||
      (item.createdByUserId === scope.userId &&
        !item.ownerUserId &&
        !item.ownerParticipantId &&
        !item.ownerText?.trim())
    )
  }

  if (scope.kind === "api_key" && scope.ownerUserId) return item.ownerUserId === scope.ownerUserId

  return false
}

/** Pure filter/sort/page over already-visible meetings. */
export function filterTasks(
  meetings: MemoryTaskMeeting[],
  scope: RepoScope,
  query: TaskListQuery,
  options: TaskStoreOptions = {}
): TaskListPage {
  const todayDate = today(options)
  const needle = query.q?.trim().toLowerCase()
  const byCreated = query.sort === "created"
  const rows: TaskRow[] = []

  for (const meeting of meetings) {
    if (query.meetingId && meeting.id !== query.meetingId) continue
    if (query.roomId && !(meeting.contexts ?? []).some((context) => context.id === query.roomId)) {
      continue
    }

    for (const item of meeting.summary?.actionItems ?? []) {
      if (query.scope === "mine" && !isMine(scope, meeting, item)) continue
      if (query.status === "open" && item.status !== "open") continue
      if (query.status === "done" && item.status !== "done") continue
      if (query.status === "overdue" && !(item.status === "open" && item.dueOn && item.dueOn < todayDate)) {
        continue
      }
      if (query.ownerUserId && item.ownerUserId !== query.ownerUserId) continue
      if (query.dueFrom && !(item.dueOn && item.dueOn >= query.dueFrom)) continue
      if (query.dueTo && !(item.dueOn && item.dueOn <= query.dueTo)) continue
      if (needle && !item.title.toLowerCase().includes(needle)) continue

      rows.push({
        ...item,
        meetingId: meeting.id,
        meeting: {
          id: meeting.id,
          title: meeting.title,
          startedAt: meeting.startedAt,
          language: meeting.languageMetadata?.primaryLanguage ?? meeting.language,
        },
      })
    }
  }

  rows.sort((a, b) => compareTasks(a, b, byCreated))

  let start = 0

  if (query.cursor) {
    const cursor = decodeTaskCursor(query.cursor)
    const index = rows.findIndex((row) => row.id === cursor.i)

    start = index >= 0 ? index + 1 : rows.length
  }

  const limit = clampLimit(query.limit)
  const tasks = rows.slice(start, start + limit)
  const last = tasks.at(-1)

  return {
    tasks,
    nextCursor:
      start + limit < rows.length && last
        ? encodeTaskCursor({
            // Memory paging only uses `i`; `d`/`c` must still decode.
            d: last.dueOn && isCursorDate(last.dueOn) ? last.dueOn : null,
            c: last.createdAt && isCursorTimestamp(last.createdAt) ? last.createdAt : new Date(0).toISOString(),
            i: last.id,
          })
        : undefined,
  }
}

/**
 * Tasks of every meeting `scope` can see. Postgres when configured,
 * otherwise the in-memory demo repository (`repository`, normally the
 * route's already-scoped `ctx.meetings`).
 */
export async function listTasks(
  scope: RepoScope,
  query: TaskListQuery,
  options: TaskStoreOptions & { repository?: Pick<MeetingRepository, "listMeetings"> } = {}
): Promise<TaskListPage> {
  if (process.env.MEETSUM_STORAGE === "postgres") {
    const { getDatabasePool } = await import("@/lib/db/client")

    return listTasksPostgres(getDatabasePool(), scope, query, options)
  }

  const repository =
    options.repository ??
    (await import("@/lib/meetings/store")).getScopedMeetingRepository(scope)
  const meetings = await repository.listMeetings({ limit: 100 })

  return filterTasks(meetings, scope, query, options)
}
