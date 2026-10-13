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
 * Every Postgres statement is scoped by workspace_id except
 * findByVexaMeetingId and findOpenByTarget, which the webhook uses to resolve
 * the session's own workspace. Methods that take an optional `workspaceId`
 * scope by it when given (routes always pass it; workers resolve the session
 * first and then pass its workspace).
 */

export type BotEventSource = "webhook" | "poll" | "api"

export type BotEvent = {
  id: string
  botSessionId: string | null
  workspaceId: string | null
  source: BotEventSource
  vexaMeetingId: string | null
  vexaEventId: string | null
  eventType: string
  vexaStatus: string | null
  applied: boolean
  /** Redacted (no URL queries, no *secret* / *token* keys). */
  payload: Record<string, unknown>
  receivedAt: string
}

export type BotEventInput = {
  botSessionId?: string | null
  workspaceId?: string | null
  source: BotEventSource
  vexaMeetingId?: string | null
  vexaEventId?: string | null
  eventType: string
  vexaStatus?: string | null
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
  workspaceId?: string
  event?: BotTransitionEvent
}

export type BotTransitionResult = {
  applied: boolean
  session: BotSessionRecord
  previous: BotSessionRecord
}

/** Opaque transaction handle (a pg PoolClient for Postgres). */
export type BotStoreTx = { readonly kind: "bot_store_tx" }

/** A unique index rejected the write (live target or calendar event already taken). */
export class BotSessionConflictError extends Error {
  readonly constraint: "uq_bot_sessions_live_target" | "uq_bot_sessions_calendar"

  constructor(constraint: BotSessionConflictError["constraint"]) {
    super(`bot session conflict: ${constraint}`)
    this.name = "BotSessionConflictError"
    this.constraint = constraint
  }
}

export interface BotSessionStore {
  create(input: BotSessionCreateInput): Promise<BotSessionRecord>
  get(id: string, options?: { workspaceId?: string }): Promise<BotSessionRecord | undefined>
  /** `select ... for update` inside withTransaction. */
  getForUpdate(id: string, tx: BotStoreTx): Promise<BotSessionRecord | undefined>
  /** Webhook-only: not workspace-scoped. */
  findByVexaMeetingId(vexaMeetingId: string): Promise<BotSessionRecord | undefined>
  /** Webhook-only: newest non-terminal session for the target, any workspace. */
  findOpenByTarget(
    platform: BotPlatform,
    nativeMeetingId: string
  ): Promise<BotSessionRecord | undefined>
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
  /** Instance-wide, for reconcile; `olderThan` filters on last_event_at. */
  listOpen(options?: { olderThan?: Date }): Promise<BotSessionRecord[]>
  /** `scheduled` with dispatch_at <= now, instance-wide. */
  listDueForDispatch(now: Date): Promise<BotSessionRecord[]>
  /** Vexa artifacts due for deletion (B6), instance-wide. */
  listPurgeable(before: Date): Promise<BotSessionRecord[]>
  /** Returns undefined when not found or `expectedRev` does not match dispatch_rev. */
  update(
    id: string,
    patch: BotSessionPatch,
    options?: { expectedRev?: number; workspaceId?: string; tx?: BotStoreTx }
  ): Promise<BotSessionRecord | undefined>
  /** Rank-guarded, transactional; records bot_events; bumps last_event_at. */
  transition(id: string, input: BotTransitionInput): Promise<BotTransitionResult | undefined>
  countLive(options?: { workspaceId?: string }): Promise<number>
  countCreatedSince(workspaceId: string, since: Date): Promise<number>
  /** Idempotent on the bot_events unique indexes. */
  recordEvent(input: BotEventInput): Promise<{ duplicate: boolean; event?: BotEvent }>
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
