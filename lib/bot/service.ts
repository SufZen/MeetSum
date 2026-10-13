import { NextResponse } from "next/server"

import type {
  BotErrorCode,
  BotErrorResponse,
  BotJoinLanguage,
  BotMeetingRef,
  BotSessionsResponse,
  BotSettingsResponse,
  BotStatusResponse,
  JoinBotResponse,
  MeetingBotResponse,
} from "@/lib/bot/api-types"
import { recordAuditLog, type AuditAction } from "@/lib/audit"
import type { AuthContext } from "@/lib/auth/authz"
import { can } from "@/lib/auth/authz"
import { extractCalendarMeetingLink } from "@/lib/bot/calendar-links"
import { getBotConfig, type BotConfig } from "@/lib/bot/config"
import { dispatchNow, scheduleDispatch, sealMeetingSecrets } from "@/lib/bot/dispatch"
import { diagnoseMeetingLink, extractMeetingLinks, parseMeetingLink } from "@/lib/bot/meeting-url"
import { enqueueBotJob, removeBotJob } from "@/lib/bot/queue"
import { redactBotError } from "@/lib/bot/redact"
import { BotSessionConflictError, getBotSessionStore, type BotSessionStore } from "@/lib/bot/store"
import {
  isLiveBotStatus,
  isTerminalBotStatus,
  toBotSessionSummary,
  type BotPlatform,
  type BotRulesPatch,
  type BotSessionRecord,
  type CalendarEventLike,
  type ParsedMeetingLink,
} from "@/lib/bot/types"
import { getBotProvider } from "@/lib/bot/vexa/client"
import { VexaError } from "@/lib/bot/vexa/types"
import { getDatabasePool } from "@/lib/db/client"
import type { MeetingRecord } from "@/lib/meetings/repository"
import { checkRateLimit } from "@/lib/rate-limit"
import { getAppSettings } from "@/lib/settings/app-settings"
import { getBotRules, updateBotRules } from "@/lib/settings/bot-rules"

/**
 * Bot route logic (M7 B7). Routes stay thin `withAuthz` adapters; this
 * module never trusts a client-supplied workspace (always `ctx.workspace`)
 * and reads meetings only through the caller-scoped `ctx.meetings`, so an
 * invisible meeting is a 404 indistinguishable from a missing one. Responses
 * carry `BotSessionSummary` only: never a passcode or a raw meeting URL.
 */

export const JOIN_RATE_LIMIT = { maxRequests: 5, windowMs: 60_000 } as const
const ATTACH_WINDOW_MS = 2 * 3_600_000
const RECENT_TERMINAL_MS = 24 * 3_600_000
const MAX_INPUT_CHARS = 8_000

const PLATFORM_LABELS: Record<BotPlatform, string> = {
  google_meet: "Google Meet",
  teams: "Microsoft Teams",
  zoom: "Zoom",
}

type Ctx = AuthContext

export function botError(
  error: BotErrorCode,
  status: number,
  extra: Omit<BotErrorResponse, "error"> = {},
  headers?: Record<string, string>
) {
  return NextResponse.json({ error, ...extra } satisfies BotErrorResponse, { status, headers })
}

export function botDisabled() {
  return botError("bot_disabled", 404)
}

/** Meeting lookups that need columns the repository does not expose. */
export type BotMeetingLinkLookup = {
  /** Link + calendar event of a meeting (calendar raw first, then google_meet_link). */
  meetingLink(
    workspaceId: string,
    meetingId: string
  ): Promise<{ link?: ParsedMeetingLink; calendarEventId?: string } | undefined>
  /** Scheduled meetings of the workspace starting within ±2 h whose link matches. */
  attachCandidates(
    workspaceId: string,
    link: ParsedMeetingLink,
    around: Date
  ): Promise<string[]>
}

type LinkRow = { id: string; google_meet_link?: string | null; calendar_event_id?: string | null; raw?: unknown }

function linkFromRow(row: LinkRow): ParsedMeetingLink | undefined {
  const raw = row.raw && typeof row.raw === "object" ? (row.raw as CalendarEventLike) : undefined

  return (
    (raw ? extractCalendarMeetingLink(raw) : undefined) ??
    (row.google_meet_link ? parseMeetingLink(row.google_meet_link, "hangout_link") : undefined)
  )
}

function sameTarget(a: Pick<ParsedMeetingLink, "platform" | "nativeMeetingId">, b: typeof a) {
  return a.platform === b.platform && a.nativeMeetingId === b.nativeMeetingId
}

/** Postgres lookups, workspace-scoped; memory mode has no calendar data. */
export const postgresMeetingLinkLookup: BotMeetingLinkLookup = {
  async meetingLink(workspaceId, meetingId) {
    if (process.env.MEETSUM_STORAGE !== "postgres") return undefined

    const result = await getDatabasePool().query(
      `select m.id, m.google_meet_link, m.calendar_event_id, ce.raw
       from meetings m
       left join calendar_events ce on ce.id = m.calendar_event_id
       where m.id = $1 and m.workspace_id = $2
       limit 1`,
      [meetingId, workspaceId]
    )
    const row = result.rows[0] as LinkRow | undefined

    return row
      ? { link: linkFromRow(row), calendarEventId: row.calendar_event_id ?? undefined }
      : undefined
  },

  async attachCandidates(workspaceId, link, around) {
    if (process.env.MEETSUM_STORAGE !== "postgres") return []

    const result = await getDatabasePool().query(
      `select m.id, m.google_meet_link, m.calendar_event_id, ce.raw
       from meetings m
       left join calendar_events ce on ce.id = m.calendar_event_id
       where m.workspace_id = $1 and m.status = 'scheduled'
         and m.started_at between $2 and $3
       order by abs(extract(epoch from (m.started_at - $4::timestamptz))) asc
       limit 50`,
      [
        workspaceId,
        new Date(around.getTime() - ATTACH_WINDOW_MS).toISOString(),
        new Date(around.getTime() + ATTACH_WINDOW_MS).toISOString(),
        around.toISOString(),
      ]
    )

    return (result.rows as LinkRow[]).flatMap((row) => {
      const candidate = linkFromRow(row)

      return candidate && sameTarget(candidate, link) ? [row.id] : []
    })
  },
}

let linkLookup: BotMeetingLinkLookup = postgresMeetingLinkLookup

/** Test hook. */
export function setBotMeetingLinkLookup(lookup: BotMeetingLinkLookup | undefined) {
  linkLookup = lookup ?? postgresMeetingLinkLookup
}

function store(): BotSessionStore {
  return getBotSessionStore()
}

function meetingRef(meeting: MeetingRecord): BotMeetingRef {
  return {
    id: meeting.id,
    title: meeting.title,
    status: meeting.status,
    startedAt: meeting.startedAt ?? null,
  }
}

function actorUserId(ctx: Ctx): string | undefined {
  return ctx.principal === "user" ? ctx.user?.id : ctx.apiKey?.createdByUserId
}

async function audit(
  ctx: Ctx,
  action: AuditAction,
  session: Pick<BotSessionRecord, "id" | "meetingId" | "platform" | "status">,
  metadata: Record<string, unknown> = {}
) {
  await recordAuditLog({
    workspaceId: ctx.audit.workspaceId,
    actor: ctx.audit.actor,
    actorUserId: ctx.audit.actorUserId,
    actorApiKeyId: ctx.audit.actorApiKeyId,
    action,
    targetType: "bot_session",
    targetId: session.id,
    metadata: {
      meetingId: session.meetingId,
      platform: session.platform,
      status: session.status,
      ...metadata,
    },
  }).catch(() => undefined)
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown

    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function linkInput(body: Record<string, unknown>): string | undefined {
  const value =
    typeof body.meetingUrl === "string" && body.meetingUrl.trim()
      ? body.meetingUrl
      : typeof body.text === "string"
        ? body.text
        : undefined

  return value?.trim() ? value.slice(0, MAX_INPUT_CHARS) : undefined
}

function joinLanguage(value: unknown): BotJoinLanguage | undefined {
  return value === "he" || value === "en" || value === "auto" ? value : undefined
}

function transcribeEnabled(config: BotConfig): boolean {
  return config.transcribe || config.live.enabled
}

function rateLimited(retryAfterSeconds?: number) {
  return botError(
    "bot_rate_limited",
    429,
    {},
    retryAfterSeconds ? { "Retry-After": String(Math.max(1, retryAfterSeconds)) } : undefined
  )
}

async function hasCapacity(workspaceId: string, config: BotConfig): Promise<boolean> {
  const [instance, workspace] = await Promise.all([
    store().countLive(),
    store().countLive({ workspaceId }),
  ])

  return instance < config.maxConcurrent && workspace < config.maxConcurrentPerWorkspace
}

async function safeDispatchNow(session: BotSessionRecord): Promise<BotSessionRecord> {
  try {
    // The store is workspace-scoped: pass the session (id + workspaceId).
    const dispatched = await dispatchNow(session)

    return { ...session, ...dispatched, passcodeEnc: session.passcodeEnc }
  } catch (error) {
    // The session stays `scheduled` with dispatch_at <= now: reconcile retries.
    console.error("[bot] dispatchNow failed", redactBotError(error))
    return session
  }
}

/** POST /api/meetings/bot — Join now. */
export async function joinBotNow(request: Request, ctx: Ctx): Promise<Response> {
  const config = getBotConfig()

  if (!config.enabled) return botDisabled()

  const workspaceId = ctx.workspace.id
  const userKey = ctx.user?.id ?? ctx.apiKey?.id ?? "anonymous"

  if (process.env.MEETSUM_RATE_LIMIT !== "false") {
    const limited = checkRateLimit(`bot-join:user:${userKey}`, JOIN_RATE_LIMIT)

    if (!limited.allowed) {
      return rateLimited(Math.ceil((limited.resetMs - Date.now()) / 1000))
    }
  }

  const body = await readJson(request)
  const input = linkInput(body)
  const link = input ? extractMeetingLinks(input, "input")[0] : undefined

  if (!input || !link) {
    return botError("invalid_meeting_link", 400, {
      reason: input ? diagnoseMeetingLink(input) : "no_link",
    })
  }

  const now = new Date()

  if (
    (await store().countCreatedSince(workspaceId, new Date(now.getTime() - 3_600_000))) >=
    config.joinRatePerHour
  ) {
    return rateLimited(60)
  }

  const open = (await store().listActive(workspaceId)).find(
    (session) =>
      !isTerminalBotStatus(session.status) && sameTarget(session, link)
  )

  if (open) {
    const meeting = open.meetingId ? await ctx.meetings.getMeeting(open.meetingId, { includeTranscript: false }) : undefined

    if (!meeting) return botError("bot_already_in_meeting", 409)

    return NextResponse.json(
      { meeting: meetingRef(meeting), session: toBotSessionSummary(open), reused: true } satisfies JoinBotResponse,
      { status: 200 }
    )
  }

  if (!(await hasCapacity(workspaceId, config))) return botError("bot_capacity", 429)

  const language = joinLanguage(body.language)
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : ""
  let meeting: MeetingRecord | undefined
  let created = false

  for (const candidateId of await linkLookup.attachCandidates(workspaceId, link, now)) {
    const candidate = await ctx.meetings.getMeeting(candidateId, { includeTranscript: false })

    if (candidate?.status === "scheduled") {
      meeting = candidate
      break
    }
  }

  if (!meeting) {
    const settings = await getAppSettings(workspaceId)

    meeting = await ctx.meetings.createMeeting({
      source: "meeting_bot",
      title: title || `${PLATFORM_LABELS[link.platform]} meeting`,
      language: language ?? "he",
      startedAt: now.toISOString(),
      ownerUserId: actorUserId(ctx),
      visibility: settings.defaultMeetingVisibility,
    })
    created = true
  }

  const rules = await getBotRules(workspaceId)
  let session: BotSessionRecord

  try {
    session = await store().create({
      workspaceId,
      meetingId: meeting.id,
      origin: "manual",
      platform: link.platform,
      nativeMeetingId: link.nativeMeetingId,
      meetingUrlRedacted: link.redactedUrl,
      passcodeEnc: sealMeetingSecrets(link),
      teamsBaseHost: link.teamsBaseHost ?? null,
      requestedByUserId: actorUserId(ctx) ?? null,
      scheduledStart: now.toISOString(),
      dispatchAt: now.toISOString(),
      botName: rules.botName || config.botName,
      language: language === "auto" ? null : (language ?? meeting.language ?? null),
      transcribeEnabled: transcribeEnabled(config),
    })
  } catch (error) {
    if (error instanceof BotSessionConflictError) {
      if (created) await ctx.meetings.discardMeeting(meeting.id).catch(() => false)
      return botError("bot_already_in_meeting", 409)
    }
    throw error
  }

  const dispatched = await safeDispatchNow(session)

  await audit(ctx, "bot.join_requested", dispatched, { origin: "manual", attached: !created })

  return NextResponse.json(
    { meeting: meetingRef(meeting), session: toBotSessionSummary(dispatched) } satisfies JoinBotResponse,
    { status: 201 }
  )
}

/** GET /api/meetings/[id]/bot */
export async function getMeetingBot(ctx: Ctx, meetingId: string): Promise<Response> {
  if (!getBotConfig().enabled) return botDisabled()

  const meeting = await ctx.meetings.getMeeting(meetingId, { includeTranscript: false })

  if (!meeting) return botError("not_found", 404)

  const sessions = await store().listForMeeting(ctx.workspace.id, meeting.id)
  const open = sessions.find((session) => !isTerminalBotStatus(session.status))
  const current = open ?? sessions[0]
  const lookup = await linkLookup.meetingLink(ctx.workspace.id, meeting.id).catch(() => undefined)
  const link = lookup?.link ?? (current?.meetingUrlRedacted
    ? { platform: current.platform, redactedUrl: current.meetingUrlRedacted }
    : undefined)

  return NextResponse.json({
    session: current ? toBotSessionSummary(current) : undefined,
    history: sessions.map(toBotSessionSummary),
    canSend: !open && can(ctx.role, "meeting:write"),
    link: link ? { platform: link.platform, redactedUrl: link.redactedUrl } : undefined,
  } satisfies MeetingBotResponse)
}

/** POST /api/meetings/[id]/bot — Send bot to this meeting. */
export async function sendBotToMeeting(
  request: Request,
  ctx: Ctx,
  meetingId: string
): Promise<Response> {
  const config = getBotConfig()

  if (!config.enabled) return botDisabled()

  const meeting = await ctx.meetings.getMeeting(meetingId, { includeTranscript: false })

  if (!meeting) return botError("not_found", 404)

  const workspaceId = ctx.workspace.id
  const body = await readJson(request)
  const input = linkInput(body)
  const lookup = await linkLookup.meetingLink(workspaceId, meeting.id).catch(() => undefined)
  const link = input ? extractMeetingLinks(input, "input")[0] : lookup?.link

  if (!link) {
    return input
      ? botError("invalid_meeting_link", 400, { reason: diagnoseMeetingLink(input) })
      : botError("bot_no_link", 400)
  }

  const sessions = await store().listForMeeting(workspaceId, meeting.id)
  const open = sessions.find((session) => !isTerminalBotStatus(session.status))

  if (open) return NextResponse.json({ session: toBotSessionSummary(open) }, { status: 200 })

  const rules = await getBotRules(workspaceId)
  const now = new Date()
  const start = Date.parse(meeting.startedAt)
  const dispatchAtMs = Number.isFinite(start) ? start - rules.joinLeadSeconds * 1000 : now.getTime()
  const later = dispatchAtMs > now.getTime()
  const dispatchAt = new Date(later ? dispatchAtMs : now.getTime()).toISOString()
  const calendarEventId = lookup?.calendarEventId
  const existing = calendarEventId
    ? await store().findByCalendarEvent(workspaceId, calendarEventId)
    : undefined
  let session: BotSessionRecord | undefined

  try {
    if (existing && existing.status === "cancelled" && existing.statusReason === "user_opt_out") {
      // Reopen the user's opt-out; the bumped rev voids any old dispatch job.
      // It is now the user's explicit request: calendar polls must not cancel
      // it, and its dispatch window runs from this request.
      session = await store().update(
        existing.id,
        {
          status: "scheduled",
          statusReason: null,
          origin: "meeting_request",
          requestedAt: now.toISOString(),
          dispatchRev: existing.dispatchRev + 1,
          dispatchAt,
          meetingUrlRedacted: link.redactedUrl,
          passcodeEnc: sealMeetingSecrets(link) ?? existing.passcodeEnc,
        },
        { workspaceId, expectedRev: existing.dispatchRev }
      )
    }

    session ??= await store().create({
      workspaceId,
      meetingId: meeting.id,
      origin: "meeting_request",
      platform: link.platform,
      nativeMeetingId: link.nativeMeetingId,
      meetingUrlRedacted: link.redactedUrl,
      passcodeEnc: sealMeetingSecrets(link),
      teamsBaseHost: link.teamsBaseHost ?? null,
      requestedByUserId: actorUserId(ctx) ?? null,
      // A terminal calendar session keeps the (workspace, event) key.
      calendarEventId: existing ? null : (calendarEventId ?? null),
      scheduledStart: Number.isFinite(start) ? new Date(start).toISOString() : null,
      dispatchAt,
      botName: rules.botName || config.botName,
      language: meeting.language ?? null,
      transcribeEnabled: transcribeEnabled(config),
    })
  } catch (error) {
    if (error instanceof BotSessionConflictError) return botError("bot_already_in_meeting", 409)
    throw error
  }

  if (later) {
    await scheduleDispatch(session).catch((error: unknown) => {
      console.error("[bot] scheduleDispatch failed", redactBotError(error))
    })
    await audit(ctx, "bot.scheduled", session, { origin: session.origin, dispatchAt })
  } else {
    session = await safeDispatchNow(session)
    await audit(ctx, "bot.join_requested", session, { origin: session.origin })
  }

  return NextResponse.json({ session: toBotSessionSummary(session) }, { status: 201 })
}

/** DELETE /api/meetings/[id]/bot — "Don't send bot" or "Stop recording". */
export async function stopMeetingBot(ctx: Ctx, meetingId: string): Promise<Response> {
  if (!getBotConfig().enabled) return botDisabled()

  const meeting = await ctx.meetings.getMeeting(meetingId, { includeTranscript: false })

  if (!meeting) return botError("not_found", 404)

  const workspaceId = ctx.workspace.id
  const sessions = await store().listForMeeting(workspaceId, meeting.id)
  const session = sessions.find((item) => !isTerminalBotStatus(item.status))

  if (!session) {
    return sessions.length ? botError("bot_session_terminal", 409) : botError("not_found", 404)
  }

  if (session.status === "scheduled") {
    const result = await store().transition(session.id, {
      status: "cancelled",
      reason: "user_opt_out",
      at: new Date(),
      source: "api",
      workspaceId,
    })

    if (!result?.applied) return botError("bot_session_terminal", 409)

    await removeBotJob(`bot.dispatch:${session.id}:${session.dispatchRev}`).catch(() => undefined)
    await audit(ctx, "bot.cancelled", result.session, { reason: "user_opt_out" })

    return NextResponse.json({ session: toBotSessionSummary(result.session) })
  }

  // A `requested` session without a Vexa id has its POST in flight (or
  // failing): mark it stopping and let the dispatcher stop whatever bot the
  // POST starts (runDispatch re-reads the session after requestBot).
  const postInFlight = session.status === "requested" && !session.vexaMeetingId

  if (isLiveBotStatus(session.status) && !postInFlight) {
    try {
      await getBotProvider().stopBot(session.platform, session.nativeMeetingId)
    } catch (error) {
      if (!(error instanceof VexaError && error.kind === "not_found")) {
        console.error("[bot] stopBot failed", redactBotError(error))
        return botError("bot_provider_unavailable", 502)
      }
    }
  }

  const result = await store().transition(session.id, {
    status: "stopping",
    reason: "user_stopped",
    at: new Date(),
    source: "api",
    workspaceId,
  })
  const updated = result?.session ?? session

  await audit(ctx, "bot.stop_requested", updated, { reason: "user_stopped" })

  return NextResponse.json({ session: toBotSessionSummary(updated) })
}

/** GET /api/bot/sessions?active=1 — newest session per visible meeting. */
export async function listBotSessions(request: Request, ctx: Ctx): Promise<Response> {
  if (!getBotConfig().enabled) return botDisabled()

  const active = new URL(request.url).searchParams.get("active") !== "0"
  const since = new Date(Date.now() - RECENT_TERMINAL_MS)
  const sessions = active
    ? await store().listActive(ctx.workspace.id, { since })
    : await store().listActive(ctx.workspace.id, { since: new Date(Date.now() - 7 * RECENT_TERMINAL_MS) })
  const byMeetingId: BotSessionsResponse["byMeetingId"] = {}
  const visibility = new Map<string, boolean>()

  // Open sessions win, then newest first: keep the first session per meeting.
  const ordered = [...sessions].sort(
    (a, b) =>
      Number(isTerminalBotStatus(a.status)) - Number(isTerminalBotStatus(b.status)) ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt)
  )

  for (const session of ordered) {
    if (!session.meetingId || byMeetingId[session.meetingId]) continue

    let visible = visibility.get(session.meetingId)

    if (visible === undefined) {
      visible = Boolean(
        await ctx.meetings.getMeeting(session.meetingId, { includeTranscript: false })
      )
      visibility.set(session.meetingId, visible)
    }

    if (visible) byMeetingId[session.meetingId] = toBotSessionSummary(session)
  }

  return NextResponse.json({ byMeetingId } satisfies BotSessionsResponse)
}

/** GET /api/bot/status (ops:read). */
export async function getBotStatusResponse(): Promise<Response> {
  const config = getBotConfig()
  const base: BotStatusResponse = {
    enabled: config.enabled,
    vexaVersion: config.vexa.version,
    healthy: false,
    running: 0,
    capacity: { max: config.maxConcurrent, perWorkspace: config.maxConcurrentPerWorkspace },
    webhookConfigured: false,
  }

  if (!config.enabled) return NextResponse.json(base)

  base.running = await store().countLive().catch(() => 0)

  try {
    const provider = getBotProvider()
    const [health, webhook] = await Promise.all([
      provider.health(),
      provider.getWebhook().catch(() => undefined),
    ])

    base.healthy = health.ok
    base.vexaVersion = health.version ?? base.vexaVersion
    base.webhookConfigured = Boolean(webhook?.url) && Boolean(config.vexa.webhookSecret)
  } catch (error) {
    console.warn("[bot] status check failed", redactBotError(error))
  }

  return NextResponse.json(base)
}

/** GET /api/settings/bot (workspace:read). */
export async function getBotSettingsResponse(ctx: Ctx): Promise<Response> {
  const config = getBotConfig()

  if (!config.enabled) return NextResponse.json({ enabled: false } satisfies BotSettingsResponse)

  return NextResponse.json({
    enabled: true,
    rules: await getBotRules(ctx.workspace.id),
    editable: can(ctx.role, "settings:write"),
    envInternalDomains: config.internalDomains,
  } satisfies BotSettingsResponse)
}

type RulesError = Error & { code?: string; fields?: Record<string, string> }

/** PUT /api/settings/bot (settings:write). */
export async function updateBotSettingsResponse(request: Request, ctx: Ctx): Promise<Response> {
  if (!getBotConfig().enabled) return botDisabled()

  const body = await readJson(request)
  const patch = body as BotRulesPatch
  const before = await getBotRules(ctx.workspace.id)
  let rules

  try {
    rules = await updateBotRules(ctx.workspace.id, patch, {
      userId: ctx.user?.id,
      apiKeyId: ctx.apiKey?.id,
    })
  } catch (error) {
    const failure = error as RulesError

    if (failure?.code === "consent_ack_required") return botError("consent_ack_required", 400)
    if (failure?.fields || failure?.code === "validation_failed") {
      return botError("validation_failed", 400, failure.fields ? { fields: failure.fields } : {})
    }
    throw error
  }

  await enqueueBotJob(
    "bot.reconcile",
    { workspaceId: ctx.workspace.id, resyncRules: true },
    { jobId: `bot.reconcile:rules:${ctx.workspace.id}:${Date.now()}` }
  ).catch((error: unknown) => {
    console.error("[bot] rules resync enqueue failed", redactBotError(error))
  })

  await recordAuditLog({
    workspaceId: ctx.audit.workspaceId,
    actor: ctx.audit.actor,
    actorUserId: ctx.audit.actorUserId,
    actorApiKeyId: ctx.audit.actorApiKeyId,
    action: "bot.rules.updated",
    targetType: "workspace",
    targetId: ctx.workspace.id,
    metadata: { autoJoin: rules.autoJoin, fields: Object.keys(patch).slice(0, 20) },
  }).catch(() => undefined)

  if (rules.consentAcknowledgedAt && rules.consentAcknowledgedAt !== before.consentAcknowledgedAt) {
    await recordAuditLog({
      workspaceId: ctx.audit.workspaceId,
      actor: ctx.audit.actor,
      actorUserId: ctx.audit.actorUserId,
      actorApiKeyId: ctx.audit.actorApiKeyId,
      action: "bot.consent.acknowledged",
      targetType: "workspace",
      targetId: ctx.workspace.id,
      metadata: { acknowledgedAt: rules.consentAcknowledgedAt },
    }).catch(() => undefined)
  }

  return NextResponse.json({ rules })
}
