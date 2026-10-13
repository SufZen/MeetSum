import { createMemoryBotSessionStore } from "@/lib/bot/store-memory"
import { createPostgresBotSessionStore } from "@/lib/bot/store-postgres"
import type {
  BotConsentStatus,
  BotOrigin,
  BotPlatform,
  BotSessionRecord,
  BotStatus,
  BotStatusReason,
} from "@/lib/bot/types"
import { getDatabasePool } from "@/lib/db/client"

/**
 * bot_sessions / bot_events persistence (M7 B1). Owned by Package B.
 *
 * Workspace scope is mandatory on every per-session path: `get`,
 * `getForUpdate`, `update` and `transition` take a required `workspaceId`
 * and a session of another workspace is simply "not found" (nothing
 * changes). Every unique key is workspace-scoped too, so one workspace's
 * session never blocks another workspace's bot for the same meeting.
 *
 * System lookups that return rows of any workspace are explicitly named and
 * documented as such: `getForWebhook` (webhook resolution; the caller takes
 * the workspace from the returned row, never from the payload) and the
 * instance-wide worker lists (`listOpen`, `listDueForDispatch`,
 * `listPurgeable`, `listCompletedWithoutFinalize`, `countLive` without a workspace, `pruneEventPayloads`).
 */

export type BotEventSource = "webhook" | "poll" | "api"

/** Required workspace scope for per-session reads and writes. */
export type BotWorkspaceScope = { workspaceId: string }

export type BotEvent = {
  id: string
  botSessionId: string | null
  workspaceId: string | null
  source: BotEventSource
  vexaMeetingId: string | null
  vexaEventId: string | null
  eventType: string
  vexaStatus: string | null
  /** Status before this event (Vexa's, else the session's at receipt); part of the webhook dedupe key. */
  prevStatus: string | null
  applied: boolean
  /** Redacted (no URL queries, no *secret* / *token* keys). */
  payload: Record<string, unknown>
  receivedAt: string
}

export type BotEventInput = {
  botSessionId?: string | null
  /** Always the resolved session's workspace (dedupe keys include it). */
  workspaceId: string
  source: BotEventSource
  vexaMeetingId?: string | null
  vexaEventId?: string | null
  eventType: string
  vexaStatus?: string | null
  prevStatus?: string | null
  applied?: boolean
  payload?: Record<string, unknown>
  receivedAt?: string
}

export type BotSessionCreateInput = {
  workspaceId: string
  meetingId?: string | null
  origin: BotOrigin
  platform: BotPlatform
  nativeMeetingId: string
  meetingUrlRedacted?: string | null
  /** Already encrypted with encryptSecret(). */
  passcodeEnc?: string | null
  teamsBaseHost?: string | null
  status?: BotStatus
  statusReason?: BotStatusReason | null
  requestedByUserId?: string | null
  calendarEventId?: string | null
  scheduledStart?: string | null
  scheduledEnd?: string | null
  dispatchAt?: string | null
  botName: string
  language?: string | null
  recordingEnabled?: boolean
  transcribeEnabled?: boolean
  consentStatus?: BotConsentStatus
}

/** Columns a plain update may change (status goes through `transition`). */
export type BotSessionPatch = Partial<
  Pick<
    BotSessionRecord,
    | "meetingId"
    | "meetingUrlRedacted"
    | "passcodeEnc"
    | "teamsBaseHost"
    | "vexaMeetingId"
    | "scheduledStart"
    | "scheduledEnd"
    | "dispatchAt"
    | "dispatchRev"
    | "botName"
    | "language"
    | "recordingEnabled"
    | "transcribeEnabled"
    | "consentStatus"
    | "requestedAt"
    | "recordingStatus"
    | "recordingStorageKey"
    | "mediaAssetId"
    | "ingestJobId"
    | "speakerTimeline"
    | "vexaPurgedAt"
    | "error"
    | "attempts"
    | "lastEventAt"
  >
> & {
  /**
   * Reopening a calendar opt-out turns it into the user's own request
   * (`meeting_request`), which calendar sync never cancels.
   */
  origin?: BotOrigin
  /**
   * Allowed only for scheduled-session bookkeeping (reopen an opt-out, revert
   * a capacity-refused `requested` to `scheduled`); never bypasses the rank
   * guard for Vexa-driven changes.
   */
  status?: BotStatus
  statusReason?: BotStatusReason | null
}

/** The bot_events row a transition records or marks applied. */
export type BotTransitionEvent = {
  /** Mark this already-recorded event (from recordEvent) applied/not applied. */
  eventId?: string
  eventType?: string
  vexaMeetingId?: string | null
  vexaEventId?: string | null
  vexaStatus?: string | null
  payload?: Record<string, unknown>
}

export type BotTransitionInput = {
  status: BotStatus
  reason?: BotStatusReason | null
  at: Date | string
  source: BotEventSource
  /** Required: a session of another workspace is not found. */
  workspaceId: string
  event?: BotTransitionEvent
}

export type BotTransitionResult = {
  applied: boolean
  session: BotSessionRecord
  previous: BotSessionRecord
}

export type BotUpdateOptions = BotWorkspaceScope & {
  /** Update only when dispatch_rev still equals this value. */
  expectedRev?: number
  tx?: BotStoreTx
}

/** Webhook resolution keys (Model "Workspace isolation"). */
export type BotWebhookLookup = {
  vexaMeetingId?: string | null
  platform?: BotPlatform | null
  nativeMeetingId?: string | null
}

/** Opaque transaction handle (a pg PoolClient for Postgres). */
export type BotStoreTx = { readonly kind: "bot_store_tx" }

export const BOT_SESSION_UNIQUE_CONSTRAINTS = [
  "uq_bot_sessions_ws_live_target",
  "uq_bot_sessions_calendar",
  "uq_bot_sessions_ws_vexa_meeting",
] as const
export type BotSessionUniqueConstraint = (typeof BOT_SESSION_UNIQUE_CONSTRAINTS)[number]

/**
 * A workspace-scoped unique index rejected the write (this workspace already
 * has a live bot for the target, a session for the calendar event, or the
 * Vexa meeting id).
 */
export class BotSessionConflictError extends Error {
  readonly constraint: BotSessionUniqueConstraint

  constructor(constraint: BotSessionUniqueConstraint) {
    super(`bot session conflict: ${constraint}`)
    this.name = "BotSessionConflictError"
    this.constraint = constraint
  }
}

export interface BotSessionStore {
  create(input: BotSessionCreateInput): Promise<BotSessionRecord>
  /** Workspace-scoped: another workspace's id is not found. */
  get(id: string, scope: BotWorkspaceScope): Promise<BotSessionRecord | undefined>
  /** `select ... for update` inside withTransaction; workspace-scoped. */
  getForUpdate(
    id: string,
    tx: BotStoreTx,
    scope: BotWorkspaceScope
  ): Promise<BotSessionRecord | undefined>
  /**
   * SYSTEM lookup for the Vexa webhook only (not workspace-scoped): by
   * `vexaMeetingId`, else the newest non-terminal session for
   * `(platform, nativeMeetingId)`. Ambiguous matches across workspaces
   * resolve to nothing. Callers must take the workspace from the returned
   * row, never from the payload.
   */
  getForWebhook(lookup: BotWebhookLookup): Promise<BotSessionRecord | undefined>
  findByCalendarEvent(
    workspaceId: string,
    calendarEventId: string
  ): Promise<BotSessionRecord | undefined>
  /** Newest first. */
  listForMeeting(workspaceId: string, meetingId: string): Promise<BotSessionRecord[]>
  /** Open sessions plus terminal ones updated since `since` (when given). */
  listActive(
    workspaceId: string,
    options?: { meetingIds?: string[]; since?: Date }
  ): Promise<BotSessionRecord[]>
  /** SYSTEM (reconcile), instance-wide; `olderThan` filters on last_event_at. */
  listOpen(options?: { olderThan?: Date }): Promise<BotSessionRecord[]>
  /** SYSTEM: `scheduled` with dispatch_at <= now, instance-wide. */
  listDueForDispatch(now: Date): Promise<BotSessionRecord[]>
  /** SYSTEM: Vexa artifacts due for deletion (B6), instance-wide. */
  listPurgeable(before: Date): Promise<BotSessionRecord[]>
  /**
   * SYSTEM (reconcile branch e), instance-wide: `completed` sessions updated
   * at or after `since` that joined, expect a recording and never finalized
   * (`recording_status = 'none'`). Rows carry their own workspace.
   */
  listCompletedWithoutFinalize(since: Date): Promise<BotSessionRecord[]>
  /** Undefined when not found in the workspace or `expectedRev` does not match. */
  update(
    id: string,
    patch: BotSessionPatch,
    options: BotUpdateOptions
  ): Promise<BotSessionRecord | undefined>
  /**
   * Rank-guarded, transactional; records bot_events; bumps last_event_at.
   * A terminal status also nulls `passcode_enc` (the secret ends with the session).
   */
  transition(id: string, input: BotTransitionInput): Promise<BotTransitionResult | undefined>
  /** Instance-wide without a workspace (capacity), else per workspace. */
  countLive(options?: { workspaceId?: string }): Promise<number>
  countCreatedSince(workspaceId: string, since: Date): Promise<number>
  /** Idempotent on the workspace-scoped bot_events unique indexes. */
  recordEvent(input: BotEventInput): Promise<{ duplicate: boolean; event?: BotEvent }>
  /**
   * Removes a recorded event whose apply failed, so the provider's retry is
   * not deduped and gets reprocessed. Workspace-scoped.
   */
  deleteEvent(id: string, scope: BotWorkspaceScope): Promise<void>
  /**
   * SYSTEM (retention), instance-wide: nulls `passcode_enc` on terminal
   * sessions (rows that ended before transitions cleared it). Returns the count.
   */
  clearTerminalPasscodes(): Promise<number>
  /** SYSTEM (retention): empties payloads received before `before`. */
  pruneEventPayloads(before: Date): Promise<number>
  withTransaction<T>(fn: (tx: BotStoreTx) => Promise<T>): Promise<T>
}

let memoryStore: BotSessionStore | undefined

export function getBotSessionStore(): BotSessionStore {
  if (process.env.MEETSUM_STORAGE === "postgres") {
    return createPostgresBotSessionStore(getDatabasePool())
  }

  memoryStore ??= createMemoryBotSessionStore()
  return memoryStore
}

/** Test hook: replace (or reset with undefined) the process memory store. */
export function setMemoryBotSessionStore(store: BotSessionStore | undefined) {
  memoryStore = store
}
