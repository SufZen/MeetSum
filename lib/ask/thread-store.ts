/**
 * Per-user, per-workspace Ask threads (docs/parity/m6.md, C6; owner:
 * Package C).
 *
 * - API-key principals are stateless: `createThreadStore` returns null.
 * - Threads are private to their user: every statement filters
 *   `workspace_id = $ws and user_id = $user and deleted_at is null`. Admins
 *   can't read other users' threads (another user's thread is a 404).
 * - Meeting threads additionally require the meeting to be visible to the
 *   caller (`meetingScopeSql`); room threads require the room to belong to
 *   the workspace.
 * - On read, citations whose meeting is no longer visible come back as
 *   `{unavailable: true}` with no title or quote.
 * - Postgres when `MEETSUM_STORAGE=postgres`, otherwise an in-process store.
 */
import { randomUUID } from "node:crypto"

import { toRepoScope, type AuthContext } from "@/lib/auth/authz"
import type { AskCitation, AskScope, ThreadMessage, ThreadSummary } from "@/lib/ask/types"
import type { HistoryTurn, RetrievalSummary } from "@/lib/ask/context"
import { getDatabasePool, type Queryable } from "@/lib/db/client"
import type { MeetingRepository, RepoScope } from "@/lib/meetings/repository"
import { meetingScopeSql } from "@/lib/meetings/visibility"

export const THREAD_LIST_MAX = 50
export const THREAD_MESSAGES_MAX = 200
export const THREAD_TITLE_MAX = 60

export type MessageStatus = "streaming" | "complete" | "refused" | "error" | "aborted"

export type NewMessage = {
  role: "user" | "assistant"
  content: string
  status: MessageStatus
  language?: string
}

export type MessageFinal = {
  content: string
  status: MessageStatus
  citations: AskCitation[]
  retrieval: RetrievalSummary | null
  grounded: boolean | null
  language: string
  provider?: string
  model?: string
  aiRunId?: string
  promptVersion?: string
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  costUsd?: number | null
  /** An error code (never a message). */
  error?: string
}

export type ThreadListOptions = { scope?: AskScope; archived?: boolean; limit?: number; cursor?: string }

export type ThreadStore = {
  listThreads(opts?: ThreadListOptions): Promise<{ threads: ThreadSummary[]; nextCursor: string | null }>
  /** Null when the scope target (meeting/room) isn't visible. */
  createThread(input: { scope: AskScope; title?: string | null; language?: string }): Promise<ThreadSummary | null>
  getThread(id: string): Promise<{ thread: ThreadSummary; messages: ThreadMessage[] } | null>
  /** Prior user questions and complete answers, oldest first. */
  getHistory(threadId: string, maxMessages: number): Promise<HistoryTurn[]>
  renameThread(id: string, title: string | null): Promise<ThreadSummary | null>
  archiveThread(id: string, archived: boolean): Promise<ThreadSummary | null>
  softDeleteThread(id: string): Promise<boolean>
  /** Null when the thread isn't the caller's. */
  appendMessage(threadId: string, message: NewMessage): Promise<string | null>
  finalizeMessage(messageId: string, final: MessageFinal): Promise<void>
  setFeedback(messageId: string, rating: -1 | 1 | null): Promise<boolean>
  countUserQuestionsToday(): Promise<number>
}

export class InvalidThreadCursorError extends Error {
  constructor() {
    super("Invalid cursor")
    this.name = "InvalidThreadCursorError"
  }
}

/** Title = the first question, at most 60 characters (no LLM). */
export function threadTitleFrom(question: string): string {
  const clean = question.replace(/\s+/g, " ").trim()

  return clean.length <= THREAD_TITLE_MAX ? clean : `${clean.slice(0, THREAD_TITLE_MAX - 1).trimEnd()}…`
}

export function newThreadId() {
  return `thr_${randomUUID()}`
}

export function newMessageId() {
  return `msg_${randomUUID()}`
}

type Cursor = { at: string; id: string }

export function encodeThreadCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
}

export function decodeThreadCursor(value: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>

    if (typeof parsed.at === "string" && !Number.isNaN(Date.parse(parsed.at)) && typeof parsed.id === "string") {
      return { at: parsed.at, id: parsed.id }
    }
  } catch {
    // fall through
  }
  throw new InvalidThreadCursorError()
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? 20) || 20, 1), THREAD_LIST_MAX)
}

function scopeOf(kind: string, meetingId: string | null, contextId: string | null): AskScope {
  if (kind === "meeting" && meetingId) return { kind: "meeting", meetingId }
  if (kind === "room" && contextId) return { kind: "room", roomId: contextId }
  return { kind: "workspace" }
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

/** Citations of meetings the caller can't see any more: ids only. */
export function markUnavailable(citations: readonly AskCitation[], visible: ReadonlySet<string>): AskCitation[] {
  return citations.map((citation) =>
    visible.has(citation.meetingId)
      ? citation
      : { n: citation.n, alias: citation.alias, meetingId: citation.meetingId, kind: citation.kind, meetingTitle: "", quote: "", unavailable: true }
  )
}

function citationMeetingIds(messages: Array<{ citations: AskCitation[] }>): string[] {
  return [...new Set(messages.flatMap((message) => message.citations.map((citation) => citation.meetingId)))]
}

function parseCitations(value: unknown): AskCitation[] {
  const raw = typeof value === "string" ? (JSON.parse(value) as unknown) : value

  return Array.isArray(raw) ? (raw as AskCitation[]) : []
}

/* ------------------------------------------------------------------ */
/* Postgres                                                            */
/* ------------------------------------------------------------------ */

export type PgThreadStoreOptions = { workspaceId: string; userId: string; scope: RepoScope }

type ThreadRow = {
  id: string
  scope_kind: string
  meeting_id: string | null
  context_id: string | null
  title: string | null
  message_count: number | string
  last_message_at: Date | string | null
  archived_at: Date | string | null
  sort_at?: Date | string
}

type MessageRow = {
  id: string
  role: "user" | "assistant"
  content: string
  status: string
  citations: unknown
  grounded: boolean | null
  language: string | null
  feedback: number | null
  created_at: Date | string
}

const THREAD_COLUMNS =
  "t.id, t.scope_kind, t.meeting_id, t.context_id, t.title, t.message_count, t.last_message_at, t.archived_at"

function toSummary(row: ThreadRow): ThreadSummary {
  return {
    id: row.id,
    scope: scopeOf(row.scope_kind, row.meeting_id, row.context_id),
    title: row.title,
    messageCount: Number(row.message_count) || 0,
    lastMessageAt: iso(row.last_message_at),
    archived: row.archived_at !== null && row.archived_at !== undefined,
  }
}

function param(values: unknown[], value: unknown): string {
  values.push(value)
  return `$${values.length}`
}

/**
 * Owner filter for `chat_threads t`: workspace, user, not deleted. Always
 * the first predicate of every thread statement.
 */
function ownerSql(values: unknown[], options: PgThreadStoreOptions): string {
  return `t.workspace_id = ${param(values, options.workspaceId)} and t.user_id = ${param(values, options.userId)} and t.deleted_at is null`
}

/** Meeting threads need a visible meeting; room threads a room of the workspace. */
function threadVisibilitySql(values: unknown[], options: PgThreadStoreOptions): string {
  return (
    `(t.scope_kind <> 'meeting' or exists (select 1 from meetings m where m.id = t.meeting_id and ${meetingScopeSql(options.scope, "m", values)}))` +
    ` and (t.scope_kind <> 'room' or exists (select 1 from contexts x where x.id = t.context_id and x.workspace_id = t.workspace_id))`
  )
}

export function buildListThreadsSql(options: PgThreadStoreOptions, opts: ThreadListOptions = {}) {
  const values: unknown[] = []
  const where = [ownerSql(values, options), threadVisibilitySql(values, options)]
  const limit = clampLimit(opts.limit)

  where.push(opts.archived ? "t.archived_at is not null" : "t.archived_at is null")
  if (opts.scope?.kind === "meeting") where.push(`t.scope_kind = 'meeting' and t.meeting_id = ${param(values, opts.scope.meetingId)}`)
  if (opts.scope?.kind === "room") where.push(`t.scope_kind = 'room' and t.context_id = ${param(values, opts.scope.roomId)}`)
  if (opts.scope?.kind === "workspace") where.push("t.scope_kind = 'workspace'")
  if (opts.cursor) {
    const cursor = decodeThreadCursor(opts.cursor)

    where.push(
      `(coalesce(t.last_message_at, t.created_at), t.id) < (${param(values, cursor.at)}::timestamptz, ${param(values, cursor.id)})`
    )
  }

  return {
    text: `select ${THREAD_COLUMNS}, coalesce(t.last_message_at, t.created_at) as sort_at from chat_threads t where ${where.join(" and ")} order by sort_at desc, t.id desc limit ${limit + 1}`,
    values,
    limit,
  }
}

export function buildGetThreadSql(options: PgThreadStoreOptions, id: string) {
  const values: unknown[] = []
  const owner = ownerSql(values, options)
  const visible = threadVisibilitySql(values, options)

  return {
    text: `select ${THREAD_COLUMNS} from chat_threads t where ${owner} and ${visible} and t.id = ${param(values, id)}`,
    values,
  }
}

export function buildMessagesSql(options: PgThreadStoreOptions, threadId: string, limit: number, completeOnly = false) {
  const values: unknown[] = []
  const owner = ownerSql(values, options)
  const filter = completeOnly ? " and (cm.role = 'user' or cm.status = 'complete')" : ""

  return {
    text:
      `select cm.id, cm.role, cm.content, cm.status, cm.citations, cm.grounded, cm.language, cm.feedback, cm.created_at ` +
      `from chat_messages cm join chat_threads t on t.id = cm.thread_id ` +
      `where ${owner} and cm.workspace_id = t.workspace_id and cm.thread_id = ${param(values, threadId)}${filter} ` +
      `order by cm.created_at desc, cm.id desc limit ${Math.max(1, Math.trunc(limit))}`,
    values,
  }
}

export function buildCreateThreadSql(
  options: PgThreadStoreOptions,
  input: { id: string; scope: AskScope; title: string | null; language: string | null }
) {
  const values: unknown[] = []
  const id = param(values, input.id)
  const ws = param(values, options.workspaceId)
  const user = param(values, options.userId)
  const kind = param(values, input.scope.kind)
  const meetingId = param(values, input.scope.kind === "meeting" ? input.scope.meetingId : null)
  const contextId = param(values, input.scope.kind === "room" ? input.scope.roomId : null)
  const title = param(values, input.title)
  const language = param(values, input.language)
  const guard =
    input.scope.kind === "meeting"
      ? `exists (select 1 from meetings m where m.id = ${meetingId} and ${meetingScopeSql(options.scope, "m", values)})`
      : input.scope.kind === "room"
        ? `exists (select 1 from contexts x where x.id = ${contextId} and x.workspace_id = ${ws})`
        : "true"

  return {
    text:
      `insert into chat_threads (id, workspace_id, user_id, scope_kind, meeting_id, context_id, title, language) ` +
      `select ${id}, ${ws}, ${user}, ${kind}, ${meetingId}, ${contextId}, ${title}, ${language} where ${guard} ` +
      `returning id, scope_kind, meeting_id, context_id, title, message_count, last_message_at, archived_at`,
    values,
  }
}

export function buildAppendMessageSql(options: PgThreadStoreOptions, threadId: string, id: string, message: NewMessage) {
  const values: unknown[] = []
  const thread = param(values, threadId)
  const ws = param(values, options.workspaceId)
  const user = param(values, options.userId)

  return {
    text:
      `with t as (update chat_threads set message_count = message_count + 1, last_message_at = now(), updated_at = now() ` +
      `where id = ${thread} and workspace_id = ${ws} and user_id = ${user} and deleted_at is null returning id, workspace_id) ` +
      `insert into chat_messages (id, thread_id, workspace_id, role, content, status, language) ` +
      `select ${param(values, id)}, t.id, t.workspace_id, ${param(values, message.role)}, ${param(values, message.content)}, ` +
      `${param(values, message.status)}, ${param(values, message.language ?? null)} from t returning id`,
    values,
  }
}

/** Updates a message of the caller's thread (owner filter through the thread). */
function messageOwnerSql(values: unknown[], options: PgThreadStoreOptions, messageId: string): string {
  return (
    `cm.id = ${param(values, messageId)} and t.id = cm.thread_id and t.workspace_id = ${param(values, options.workspaceId)} ` +
    `and t.user_id = ${param(values, options.userId)} and t.deleted_at is null and cm.workspace_id = t.workspace_id`
  )
}

export function buildFinalizeMessageSql(options: PgThreadStoreOptions, messageId: string, final: MessageFinal) {
  const values: unknown[] = []
  const sets = [
    `content = ${param(values, final.content)}`,
    `status = ${param(values, final.status)}`,
    `citations = ${param(values, JSON.stringify(final.citations))}::jsonb`,
    `retrieval = ${param(values, final.retrieval ? JSON.stringify(final.retrieval) : null)}::jsonb`,
    `grounded = ${param(values, final.grounded)}`,
    `language = ${param(values, final.language)}`,
    `provider = ${param(values, final.provider ?? null)}`,
    `model = ${param(values, final.model ?? null)}`,
    `ai_run_id = ${param(values, final.aiRunId ?? null)}`,
    `prompt_version = ${param(values, final.promptVersion ?? null)}`,
    `input_tokens = ${param(values, final.usage?.inputTokens ?? null)}`,
    `output_tokens = ${param(values, final.usage?.outputTokens ?? null)}`,
    `cache_read_tokens = ${param(values, final.usage?.cacheReadTokens ?? null)}`,
    `cache_write_tokens = ${param(values, final.usage?.cacheWriteTokens ?? null)}`,
    `cost_estimate = ${param(values, final.costUsd ?? null)}`,
    `error = ${param(values, final.error ?? null)}`,
  ]

  return {
    text: `update chat_messages cm set ${sets.join(", ")} from chat_threads t where ${messageOwnerSql(values, options, messageId)}`,
    values,
  }
}

export function buildSetFeedbackSql(options: PgThreadStoreOptions, messageId: string, rating: -1 | 1 | null) {
  const values: unknown[] = []
  const feedback = param(values, rating)

  return {
    text: `update chat_messages cm set feedback = ${feedback} from chat_threads t where ${messageOwnerSql(values, options, messageId)} and cm.role = 'assistant' returning cm.id`,
    values,
  }
}

export function buildUpdateThreadSql(
  options: PgThreadStoreOptions,
  id: string,
  patch: { title?: string | null; archived?: boolean; deleted?: boolean }
) {
  const values: unknown[] = []
  const sets = ["updated_at = now()"]

  if (patch.title !== undefined) sets.push(`title = ${param(values, patch.title)}`)
  if (patch.archived !== undefined) sets.push(patch.archived ? "archived_at = coalesce(archived_at, now())" : "archived_at = null")
  if (patch.deleted) sets.push("deleted_at = now()")

  const owner = ownerSql(values, options)

  return {
    text: `update chat_threads t set ${sets.join(", ")} where ${owner} and t.id = ${param(values, id)} returning ${THREAD_COLUMNS}`,
    values,
  }
}

/**
 * Today's questions by this user in this workspace. Deliberately counts
 * questions in deleted threads too, so deleting threads can't reset the
 * daily cap.
 */
export function buildCountQuestionsSql(options: PgThreadStoreOptions) {
  const values: unknown[] = []

  return {
    text:
      `select count(*)::int as n from chat_messages cm join chat_threads t on t.id = cm.thread_id ` +
      `where t.workspace_id = ${param(values, options.workspaceId)} and t.user_id = ${param(values, options.userId)} ` +
      `and cm.workspace_id = t.workspace_id and cm.role = 'user' and cm.created_at >= date_trunc('day', now())`,
    values,
  }
}

export function buildVisibleMeetingsSql(options: PgThreadStoreOptions, meetingIds: string[]) {
  const values: unknown[] = []
  const scope = meetingScopeSql(options.scope, "m", values)

  return {
    text: `select m.id from meetings m where ${scope} and m.id = any(${param(values, meetingIds)}::text[])`,
    values,
  }
}

function toMessage(row: MessageRow): ThreadMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    status: row.status,
    citations: parseCitations(row.citations),
    grounded: row.grounded,
    language: row.language,
    feedback: row.feedback === 1 || row.feedback === -1 ? row.feedback : null,
    createdAt: iso(row.created_at) ?? "",
  }
}

export function createPgThreadStore(db: Queryable, options: PgThreadStoreOptions): ThreadStore {
  const run = async <T>(sql: { text: string; values: unknown[] }) => (await db.query(sql.text, sql.values)).rows as T[]

  const visibleMeetings = async (ids: string[]): Promise<Set<string>> => {
    if (!ids.length) return new Set()
    return new Set((await run<{ id: string }>(buildVisibleMeetingsSql(options, ids))).map((row) => row.id))
  }

  return {
    async listThreads(opts = {}) {
      const sql = buildListThreadsSql(options, opts)
      const rows = await run<ThreadRow>(sql)
      const page = rows.slice(0, sql.limit)
      const last = page.at(-1)

      return {
        threads: page.map(toSummary),
        nextCursor: rows.length > sql.limit && last ? encodeThreadCursor({ at: iso(last.sort_at) ?? "", id: last.id }) : null,
      }
    },
    async createThread(input) {
      const rows = await run<ThreadRow>(
        buildCreateThreadSql(options, {
          id: newThreadId(),
          scope: input.scope,
          title: input.title ? threadTitleFrom(input.title) : null,
          language: input.language ?? null,
        })
      )

      return rows[0] ? toSummary(rows[0]) : null
    },
    async getThread(id) {
      const [row] = await run<ThreadRow>(buildGetThreadSql(options, id))

      if (!row) return null

      const messages = (await run<MessageRow>(buildMessagesSql(options, id, THREAD_MESSAGES_MAX))).reverse().map(toMessage)
      const visible = await visibleMeetings(citationMeetingIds(messages))

      return {
        thread: toSummary(row),
        messages: messages.map((message) => ({ ...message, citations: markUnavailable(message.citations, visible) })),
      }
    },
    async getHistory(threadId, maxMessages) {
      if (maxMessages <= 0) return []

      const rows = await run<MessageRow>(buildMessagesSql(options, threadId, maxMessages, true))

      return rows.reverse().map((row) => ({ role: row.role, content: row.content }))
    },
    async renameThread(id, title) {
      const [row] = await run<ThreadRow>(buildUpdateThreadSql(options, id, { title: title ? threadTitleFrom(title) : null }))

      return row ? toSummary(row) : null
    },
    async archiveThread(id, archived) {
      const [row] = await run<ThreadRow>(buildUpdateThreadSql(options, id, { archived }))

      return row ? toSummary(row) : null
    },
    async softDeleteThread(id) {
      return (await run<ThreadRow>(buildUpdateThreadSql(options, id, { deleted: true }))).length > 0
    },
    async appendMessage(threadId, message) {
      const [row] = await run<{ id: string }>(buildAppendMessageSql(options, threadId, newMessageId(), message))

      return row?.id ?? null
    },
    async finalizeMessage(messageId, final) {
      await run(buildFinalizeMessageSql(options, messageId, final))
    },
    async setFeedback(messageId, rating) {
      return (await run(buildSetFeedbackSql(options, messageId, rating))).length > 0
    },
    async countUserQuestionsToday() {
      const [row] = await run<{ n: number | string }>(buildCountQuestionsSql(options))

      return Number(row?.n ?? 0)
    },
  }
}

/* ------------------------------------------------------------------ */
/* In-process store (no database: dev, demo, tests)                    */
/* ------------------------------------------------------------------ */

type MemThread = {
  id: string
  workspaceId: string
  userId: string
  scope: AskScope
  title: string | null
  language: string | null
  messageCount: number
  lastMessageAt: string | null
  archivedAt: string | null
  deletedAt: string | null
  createdAt: string
}

type MemMessage = ThreadMessage & { threadId: string; workspaceId: string; final?: MessageFinal }

const memory = { threads: new Map<string, MemThread>(), messages: new Map<string, MemMessage>(), seq: 0 }

export function resetMemoryThreadStoreForTesting() {
  memory.threads.clear()
  memory.messages.clear()
  memory.seq = 0
}

/** Monotonic timestamps so ordering is stable within one millisecond. */
function memNow(): string {
  memory.seq = Math.max(Date.now(), memory.seq + 1)
  return new Date(memory.seq).toISOString()
}

export type MemoryThreadStoreOptions = {
  workspaceId: string
  userId: string
  meetings: Pick<MeetingRepository, "getMeeting" | "listRooms">
}

export function createMemoryThreadStore(options: MemoryThreadStoreOptions): ThreadStore {
  const isVisibleMeeting = async (meetingId: string) =>
    Boolean(await options.meetings.getMeeting(meetingId, { includeTranscript: false }))
  const isWorkspaceRoom = async (roomId: string) => (await options.meetings.listRooms()).some((room) => room.id === roomId)
  const scopeVisible = async (scope: AskScope) =>
    scope.kind === "meeting" ? isVisibleMeeting(scope.meetingId) : scope.kind === "room" ? isWorkspaceRoom(scope.roomId) : true
  const own = (thread: MemThread | undefined): thread is MemThread =>
    Boolean(thread && thread.workspaceId === options.workspaceId && thread.userId === options.userId && !thread.deletedAt)
  const ownVisible = async (id: string) => {
    const thread = memory.threads.get(id)

    return own(thread) && (await scopeVisible(thread.scope)) ? thread : undefined
  }
  const summary = (thread: MemThread): ThreadSummary => ({
    id: thread.id,
    scope: thread.scope,
    title: thread.title,
    messageCount: thread.messageCount,
    lastMessageAt: thread.lastMessageAt,
    archived: Boolean(thread.archivedAt),
  })
  const messagesOf = (threadId: string) =>
    [...memory.messages.values()].filter((message) => message.threadId === threadId && message.workspaceId === options.workspaceId)
  const ownMessage = (messageId: string) => {
    const message = memory.messages.get(messageId)

    return message && own(memory.threads.get(message.threadId)) ? message : undefined
  }
  const sameScope = (left: AskScope, right: AskScope) => JSON.stringify(left) === JSON.stringify(right)

  return {
    async listThreads(opts = {}) {
      const limit = clampLimit(opts.limit)
      const cursor = opts.cursor ? decodeThreadCursor(opts.cursor) : undefined
      const candidates = [...memory.threads.values()]
        .filter(own)
        .filter((thread) => Boolean(thread.archivedAt) === Boolean(opts.archived))
        .filter((thread) => !opts.scope || sameScope(thread.scope, opts.scope))
        .map((thread) => ({ thread, at: thread.lastMessageAt ?? thread.createdAt }))
        .sort((left, right) => right.at.localeCompare(left.at) || right.thread.id.localeCompare(left.thread.id))
        .filter(({ thread, at }) => !cursor || at < cursor.at || (at === cursor.at && thread.id < cursor.id))
      const visible: typeof candidates = []

      for (const candidate of candidates) {
        if (visible.length > limit) break
        if (await scopeVisible(candidate.thread.scope)) visible.push(candidate)
      }

      const page = visible.slice(0, limit)
      const last = page.at(-1)

      return {
        threads: page.map(({ thread }) => summary(thread)),
        nextCursor: visible.length > limit && last ? encodeThreadCursor({ at: last.at, id: last.thread.id }) : null,
      }
    },
    async createThread(input) {
      if (!(await scopeVisible(input.scope))) return null

      const thread: MemThread = {
        id: newThreadId(),
        workspaceId: options.workspaceId,
        userId: options.userId,
        scope: input.scope,
        title: input.title ? threadTitleFrom(input.title) : null,
        language: input.language ?? null,
        messageCount: 0,
        lastMessageAt: null,
        archivedAt: null,
        deletedAt: null,
        createdAt: memNow(),
      }

      memory.threads.set(thread.id, thread)
      return summary(thread)
    },
    async getThread(id) {
      const thread = await ownVisible(id)

      if (!thread) return null

      const messages = messagesOf(id)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .slice(-THREAD_MESSAGES_MAX)
      const visible = new Set<string>()

      for (const meetingId of citationMeetingIds(messages)) {
        if (await isVisibleMeeting(meetingId)) visible.add(meetingId)
      }

      return {
        thread: summary(thread),
        messages: messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          status: message.status,
          citations: markUnavailable(message.citations, visible),
          grounded: message.grounded,
          language: message.language,
          feedback: message.feedback,
          createdAt: message.createdAt,
        })),
      }
    },
    async getHistory(threadId, maxMessages) {
      if (maxMessages <= 0 || !own(memory.threads.get(threadId))) return []

      return messagesOf(threadId)
        .filter((message) => message.role === "user" || message.status === "complete")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .slice(-maxMessages)
        .map((message) => ({ role: message.role, content: message.content }))
    },
    async renameThread(id, title) {
      const thread = memory.threads.get(id)

      if (!own(thread)) return null
      thread.title = title ? threadTitleFrom(title) : null
      return summary(thread)
    },
    async archiveThread(id, archived) {
      const thread = memory.threads.get(id)

      if (!own(thread)) return null
      thread.archivedAt = archived ? (thread.archivedAt ?? memNow()) : null
      return summary(thread)
    },
    async softDeleteThread(id) {
      const thread = memory.threads.get(id)

      if (!own(thread)) return false
      thread.deletedAt = memNow()
      return true
    },
    async appendMessage(threadId, message) {
      const thread = memory.threads.get(threadId)

      if (!own(thread)) return null

      const id = newMessageId()
      const createdAt = memNow()

      memory.messages.set(id, {
        id,
        threadId,
        workspaceId: thread.workspaceId,
        role: message.role,
        content: message.content,
        status: message.status,
        citations: [],
        grounded: null,
        language: message.language ?? null,
        feedback: null,
        createdAt,
      })
      thread.messageCount += 1
      thread.lastMessageAt = createdAt
      return id
    },
    async finalizeMessage(messageId, final) {
      const message = ownMessage(messageId)

      if (!message) return
      Object.assign(message, {
        content: final.content,
        status: final.status,
        citations: final.citations,
        grounded: final.grounded,
        language: final.language,
        final,
      })
    },
    async setFeedback(messageId, rating) {
      const message = ownMessage(messageId)

      if (!message || message.role !== "assistant") return false
      message.feedback = rating
      return true
    },
    async countUserQuestionsToday() {
      const today = new Date().toISOString().slice(0, 10)

      return [...memory.messages.values()].filter((message) => {
        const thread = memory.threads.get(message.threadId)

        return (
          message.role === "user" &&
          thread?.workspaceId === options.workspaceId &&
          thread.userId === options.userId &&
          message.createdAt.slice(0, 10) === today
        )
      }).length
    },
  }
}

/** The caller's thread store, or null for API-key principals (stateless). */
export function createThreadStore(ctx: AuthContext): ThreadStore | null {
  if (ctx.principal !== "user" || !ctx.user) return null

  if (process.env.MEETSUM_STORAGE === "postgres") {
    return createPgThreadStore(getDatabasePool(), {
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      scope: toRepoScope(ctx),
    })
  }

  return createMemoryThreadStore({ workspaceId: ctx.workspace.id, userId: ctx.user.id, meetings: ctx.meetings })
}
