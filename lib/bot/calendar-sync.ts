import { extractCalendarMeetingLink } from "@/lib/bot/calendar-links"
import { type BotConfig, getBotConfig } from "@/lib/bot/config"
import { scheduleDispatch, sealMeetingSecrets } from "@/lib/bot/dispatch"
import { defaultBotQueuePort, dispatchJobId, type BotQueuePort } from "@/lib/bot/queue"
import { botLog } from "@/lib/bot/redact"
import {
  type AutoJoinSkipReason,
  ensureRecordingBotName,
  evaluateAutoJoin,
  resolveBotLanguage,
  resolveInternalDomains,
} from "@/lib/bot/rules"
import {
  BotSessionConflictError,
  type BotSessionPatch,
  type BotSessionStore,
  getBotSessionStore,
} from "@/lib/bot/store"
import type {
  BotRules,
  BotSessionRecord,
  BotStatusReason,
  CalendarEventLike,
  ParsedMeetingLink,
} from "@/lib/bot/types"
import { getBotRules } from "@/lib/settings/bot-rules"

/**
 * Calendar-driven bot scheduling (M7 A5), called from pollCalendar only when
 * the bot feature is enabled. Idempotent per calendar event: the unique
 * (workspace_id, calendar_event_id) key holds one session; reschedules bump
 * dispatch_rev and remove the old delayed job; a user opt-out is never
 * recreated; only `calendar_rule` sessions are touched.
 */

export type SyncCalendarBotSessionInput = {
  workspaceId: string
  /** The workspace DWD subject whose calendar was polled. */
  subject: string
  calendarEventId: string
  meetingId: string
  event: CalendarEventLike
}

export type CalendarSyncDeps = {
  store: BotSessionStore
  queue: BotQueuePort
  config: BotConfig
  now: () => Date
  getRules: (workspaceId: string) => Promise<BotRules>
  /** Workspace member emails (lowercase). */
  listMemberEmails: (workspaceId: string) => Promise<string[]>
  getMeetingLanguage: (workspaceId: string, meetingId: string) => Promise<string | undefined>
  seal: (link: ParsedMeetingLink) => string | null
  /** Optional Calendar invite of the bot account (MEETSUM_BOT_CALENDAR_INVITE). */
  inviteBot?: (input: { workspaceId: string; subject: string; calendarEventId: string; botEmail: string }) => Promise<void>
  /** Upcoming calendar events of a workspace for resync (raw Google events). */
  listUpcomingEvents: (
    workspaceId: string,
    window: { from: Date; to: Date }
  ) => Promise<Array<Omit<SyncCalendarBotSessionInput, "workspaceId">>>
}

export type SyncOutcome =
  | "created"
  | "rescheduled"
  | "reopened"
  | "unchanged"
  | "cancelled"
  | "times_updated"
  | "skipped"

async function defaultMemberEmails(workspaceId: string): Promise<string[]> {
  const { getWorkspaceStore } = await import("@/lib/workspaces/store")
  const members = await getWorkspaceStore().listMembers(workspaceId)

  return members.map((member) => member.user.email.toLowerCase())
}

async function defaultMeetingLanguage(workspaceId: string, meetingId: string): Promise<string | undefined> {
  const { getSystemMeetingRepository } = await import("@/lib/meetings/store")
  const meeting = await getSystemMeetingRepository(workspaceId).getMeeting(meetingId)

  return meeting?.language
}

async function defaultInviteBot(input: {
  workspaceId: string
  subject: string
  calendarEventId: string
  botEmail: string
}): Promise<void> {
  if (process.env.MEETSUM_STORAGE !== "postgres") return

  const { getDatabasePool } = await import("@/lib/db/client")
  const row = (
    await getDatabasePool().query(
      `select ce.calendar_id, ce.google_event_id
         from calendar_events ce
         join google_identities gi on gi.id = ce.google_identity_id
        where ce.id = $1 and gi.workspace_id = $2
        limit 1`,
      [input.calendarEventId, input.workspaceId]
    )
  ).rows[0] as { calendar_id?: string; google_event_id?: string } | undefined

  if (!row?.calendar_id || !row.google_event_id) return

  const [{ google }, { createDelegatedGoogleClient }] = await Promise.all([
    import("googleapis"),
    import("@/lib/google/auth"),
  ])
  const auth = await createDelegatedGoogleClient(input.subject, [
    "https://www.googleapis.com/auth/calendar.events",
  ])
  const calendar = google.calendar({ version: "v3", auth })
  const current = await calendar.events.get({ calendarId: row.calendar_id, eventId: row.google_event_id })
  const attendees = current.data.attendees ?? []

  if (attendees.some((attendee) => attendee.email?.toLowerCase() === input.botEmail)) return

  await calendar.events.patch({
    calendarId: row.calendar_id,
    eventId: row.google_event_id,
    sendUpdates: "none",
    requestBody: { attendees: [...attendees, { email: input.botEmail, optional: true }] },
  })
}

async function defaultUpcomingEvents(
  workspaceId: string,
  window: { from: Date; to: Date }
): Promise<Array<Omit<SyncCalendarBotSessionInput, "workspaceId">>> {
  if (process.env.MEETSUM_STORAGE !== "postgres") return []

  const { getDatabasePool } = await import("@/lib/db/client")
  const result = await getDatabasePool().query(
    `select ce.id as calendar_event_id, ce.raw, gi.subject_email, m.id as meeting_id
       from calendar_events ce
       join google_identities gi on gi.id = ce.google_identity_id
       join meetings m on m.calendar_event_id = ce.id and m.workspace_id = gi.workspace_id
      where gi.workspace_id = $1
        and ce.starts_at between $2 and $3
      order by ce.starts_at asc
      limit 500`,
    [workspaceId, window.from.toISOString(), window.to.toISOString()]
  )

  return (result.rows as Array<{ calendar_event_id: string; raw: unknown; subject_email: string; meeting_id: string }>).map(
    (row) => ({
      calendarEventId: row.calendar_event_id,
      meetingId: row.meeting_id,
      subject: row.subject_email,
      event: (row.raw ?? {}) as CalendarEventLike,
    })
  )
}

export function resolveCalendarSyncDeps(deps: Partial<CalendarSyncDeps> = {}): CalendarSyncDeps {
  return {
    store: deps.store ?? getBotSessionStore(),
    queue: deps.queue ?? defaultBotQueuePort,
    config: deps.config ?? getBotConfig(),
    now: deps.now ?? (() => new Date()),
    getRules: deps.getRules ?? getBotRules,
    listMemberEmails: deps.listMemberEmails ?? defaultMemberEmails,
    getMeetingLanguage: deps.getMeetingLanguage ?? defaultMeetingLanguage,
    seal: deps.seal ?? sealMeetingSecrets,
    inviteBot: deps.inviteBot ?? defaultInviteBot,
    listUpcomingEvents: deps.listUpcomingEvents ?? defaultUpcomingEvents,
  }
}

function eventTimes(event: CalendarEventLike) {
  const start = event.start?.dateTime ? new Date(event.start.dateTime) : undefined
  const end = event.end?.dateTime ? new Date(event.end.dateTime) : undefined

  return {
    scheduledStart: start && Number.isFinite(start.getTime()) ? start.toISOString() : null,
    scheduledEnd: end && Number.isFinite(end.getTime()) ? end.toISOString() : null,
  }
}

/** Sessions cancelled for these reasons come back when the rules allow again. */
const REOPENABLE: readonly BotStatusReason[] = ["rule_disabled", "event_cancelled"]

function cancelReason(reason: AutoJoinSkipReason): BotStatusReason {
  if (reason === "missed_window" || reason === "event_cancelled") return reason
  return "rule_disabled"
}

async function cancelScheduled(
  d: CalendarSyncDeps,
  session: BotSessionRecord,
  reason: BotStatusReason
): Promise<SyncOutcome> {
  // Only rule-made sessions are the calendar's to cancel; a user's request never is.
  if (session.origin !== "calendar_rule") return "unchanged"

  const result = await d.store.transition(session.id, {
    status: "cancelled",
    reason,
    at: d.now(),
    source: "api",
    workspaceId: session.workspaceId,
    event: { eventType: "calendar.cancel", payload: { reason } },
  })

  await d.queue.remove(dispatchJobId(session.id, session.dispatchRev)).catch(() => undefined)
  return result?.applied ? "cancelled" : "unchanged"
}

function linkPatch(link: ParsedMeetingLink, d: CalendarSyncDeps): BotSessionPatch {
  return {
    meetingUrlRedacted: link.redactedUrl,
    passcodeEnc: d.seal(link),
    teamsBaseHost: link.teamsBaseHost ?? null,
  }
}

export async function syncCalendarBotSession(
  input: SyncCalendarBotSessionInput,
  deps: Partial<CalendarSyncDeps> = {}
): Promise<SyncOutcome> {
  const d = resolveCalendarSyncDeps(deps)
  const { workspaceId, calendarEventId, event } = input
  const existing = await d.store.findByCalendarEvent(workspaceId, calendarEventId)
  const times = eventTimes(event)
  const timesChanged =
    existing !== undefined &&
    (existing.scheduledStart !== times.scheduledStart || existing.scheduledEnd !== times.scheduledEnd)

  // Not ours to manage (manual / Send bot) or the user said "Don't send bot".
  if (
    existing &&
    (existing.origin !== "calendar_rule" ||
      (existing.status === "cancelled" && existing.statusReason === "user_opt_out"))
  ) {
    if (!timesChanged) return "unchanged"
    await d.store.update(existing.id, times, { workspaceId })
    return "times_updated"
  }

  const [rules, members] = await Promise.all([d.getRules(workspaceId), d.listMemberEmails(workspaceId)])
  const link = extractCalendarMeetingLink(event)
  const decision = evaluateAutoJoin({
    rules,
    event,
    link,
    members,
    internalDomains: resolveInternalDomains(members, d.config, rules),
    subject: input.subject,
    now: d.now(),
    config: d.config,
  })

  if (!decision.join) {
    if (existing?.status === "scheduled") return cancelScheduled(d, existing, cancelReason(decision.reason))
    return "skipped"
  }

  const dispatchAt = decision.dispatchAt.toISOString()

  // decision.join implies a link.
  const target = link as ParsedMeetingLink

  if (!existing) {
    const meetingLanguage = await d.getMeetingLanguage(workspaceId, input.meetingId).catch(() => undefined)
    const language = resolveBotLanguage(rules.languageMode, meetingLanguage) ?? null
    let created: BotSessionRecord

    try {
      created = await d.store.create({
        workspaceId,
        meetingId: input.meetingId,
        origin: "calendar_rule",
        platform: target.platform,
        nativeMeetingId: target.nativeMeetingId,
        meetingUrlRedacted: target.redactedUrl,
        passcodeEnc: d.seal(target),
        teamsBaseHost: target.teamsBaseHost ?? null,
        calendarEventId,
        ...times,
        dispatchAt,
        botName: ensureRecordingBotName(rules.botName, language),
        language,
        recordingEnabled: true,
        transcribeEnabled: d.config.transcribe || d.config.live.enabled,
        consentStatus: rules.consentEnabled ? "pending" : "disabled",
      })
    } catch (error) {
      // A concurrent poll created it first: the next poll reconciles.
      if (error instanceof BotSessionConflictError && error.constraint === "uq_bot_sessions_calendar") {
        return "unchanged"
      }
      throw error
    }

    await scheduleDispatch(created, { queue: d.queue, now: d.now })

    if (d.config.calendarInvite && d.config.accountEmail && d.inviteBot) {
      await d
        .inviteBot({ workspaceId, subject: input.subject, calendarEventId, botEmail: d.config.accountEmail })
        .catch((error: unknown) => botLog.error(`calendar invite failed for ${created.id}`, error))
    }
    return "created"
  }

  if (existing.status === "cancelled" && existing.statusReason && REOPENABLE.includes(existing.statusReason)) {
    const reopened = await d.store.update(
      existing.id,
      {
        status: "scheduled",
        statusReason: null,
        dispatchRev: existing.dispatchRev + 1,
        dispatchAt,
        ...times,
        ...linkPatch(target, d),
      },
      { expectedRev: existing.dispatchRev, workspaceId }
    )

    if (!reopened) return "unchanged"
    await scheduleDispatch(reopened, { queue: d.queue, now: d.now })
    return "reopened"
  }

  if (existing.status !== "scheduled") {
    // Live or finished: never disturbed by a poll.
    return "unchanged"
  }

  const targetChanged =
    existing.platform !== target.platform || existing.nativeMeetingId !== target.nativeMeetingId

  if (!timesChanged && !targetChanged && existing.dispatchAt === dispatchAt) return "unchanged"

  const updated = await d.store.update(
    existing.id,
    {
      dispatchRev: existing.dispatchRev + 1,
      dispatchAt,
      ...times,
      ...(targetChanged ? linkPatch(target, d) : {}),
    },
    { expectedRev: existing.dispatchRev, workspaceId }
  )

  if (!updated) return "unchanged"
  await d.queue.remove(dispatchJobId(existing.id, existing.dispatchRev)).catch(() => undefined)
  await scheduleDispatch(updated, { queue: d.queue, now: d.now })
  return "rescheduled"
}

/** A deleted/cancelled event: a scheduled session is cancelled; a live one keeps running. */
export async function cancelCalendarBotSession(
  input: { workspaceId: string; calendarEventId: string; reason: BotStatusReason },
  deps: Partial<CalendarSyncDeps> = {}
): Promise<SyncOutcome> {
  const d = resolveCalendarSyncDeps(deps)
  const existing = await d.store.findByCalendarEvent(input.workspaceId, input.calendarEventId)

  if (!existing || existing.status !== "scheduled" || existing.origin !== "calendar_rule") return "unchanged"
  return cancelScheduled(d, existing, input.reason)
}

/** Lookahead for resync after a rules change. */
export const BOT_RESYNC_LOOKAHEAD_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Re-evaluates upcoming calendar events (calendar_events.raw joined to the
 * workspace's identities) after a rules change. Only calendar_rule sessions
 * change; opt-outs and manual sessions are left alone by syncCalendarBotSession.
 */
export async function resyncWorkspaceBotSessions(
  workspaceId: string,
  deps: Partial<CalendarSyncDeps> = {}
): Promise<Partial<Record<SyncOutcome, number>>> {
  const d = resolveCalendarSyncDeps(deps)
  const now = d.now()
  const events = await d.listUpcomingEvents(workspaceId, {
    from: new Date(now.getTime() - d.config.lateJoinMaxMinutes * 60_000),
    to: new Date(now.getTime() + BOT_RESYNC_LOOKAHEAD_MS),
  })
  const counts: Partial<Record<SyncOutcome, number>> = {}

  for (const item of events) {
    try {
      const outcome = await syncCalendarBotSession({ workspaceId, ...item }, d)

      counts[outcome] = (counts[outcome] ?? 0) + 1
    } catch (error) {
      botLog.error(`resync ${workspaceId} ${item.calendarEventId} failed`, error)
    }
  }

  return counts
}
