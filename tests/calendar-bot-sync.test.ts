import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  type CalendarSyncDeps,
  cancelCalendarBotSession,
  resyncWorkspaceBotSessions,
  syncCalendarBotSession,
} from "@/lib/bot/calendar-sync"
import { openMeetingSecrets, runDispatch } from "@/lib/bot/dispatch"
import { createMemoryBotSessionStore } from "@/lib/bot/store-memory"
import { type BotRules, type CalendarEventLike, DEFAULT_BOT_RULES } from "@/lib/bot/types"

import { fakeProvider } from "./fixtures/vexa/api/fakes"
import { fakeQueue, type QueuedJob, testBotConfig } from "./fixtures/vexa/api/harness"

const WS = "ws_a"
const TEAMS_HEBREW_DESCRIPTION = `<div dir="rtl">שלום,<br>מוזמנים לפגישת היכרות.<br>
הצטרפות לפגישה ב-Microsoft Teams:<br>
<a href="https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjY4YzEzMzQtZjBkZS00OTk1LWE4ZjAtMTIzNDU2Nzg5MDEy%40thread.v2/0?context=%7b%22Tid%22%3a%2272f988bf-86f1-41af-91ab-2d7cd011db47%22%7d">לחצו כאן להצטרפות</a><br>
מזהה פגישה: 312 345 678 901</div>`

const rules: BotRules = {
  ...DEFAULT_BOT_RULES,
  consentMessage: { ...DEFAULT_BOT_RULES.consentMessage },
  autoJoin: "external_only",
  joinLeadSeconds: 60,
  consentAcknowledgedAt: "2026-10-01T00:00:00.000Z",
  consentAcknowledgedByUserId: "user_admin",
}

function calendarEvent(overrides: Partial<CalendarEventLike> = {}): CalendarEventLike {
  return {
    id: "gcal_1",
    status: "confirmed",
    summary: "פגישת היכרות עם לקוח",
    description: TEAMS_HEBREW_DESCRIPTION,
    start: { dateTime: "2026-10-14T09:00:00.000Z" },
    end: { dateTime: "2026-10-14T10:00:00.000Z" },
    organizer: { email: "dana@acme.co.il" },
    attendees: [
      { email: "dana@acme.co.il", responseStatus: "accepted" },
      { email: "yossi@acme.co.il", responseStatus: "accepted", self: true },
      { email: "ceo@client.example", responseStatus: "needsAction" },
    ],
    ...overrides,
  }
}

function setup(rulesFor: () => BotRules = () => rules) {
  const store = createMemoryBotSessionStore()
  const provider = fakeProvider({ requestBot: vi.fn(async () => ({ vexaMeetingId: "4242", raw: {} })) })
  const config = testBotConfig()
  const queue = fakeQueue((job: QueuedJob) =>
    job.name === "bot.dispatch"
      ? runDispatch(job.payload as { sessionId: string; rev: number }, { store, provider: () => provider, queue: queue.port, config })
      : undefined
  )
  const deps: Partial<CalendarSyncDeps> = {
    store,
    queue: queue.port,
    config,
    getRules: async () => rulesFor(),
    listMemberEmails: async () => ["dana@acme.co.il", "yossi@acme.co.il"],
    getMeetingLanguage: async () => "he",
    inviteBot: vi.fn(async () => undefined),
  }

  return { store, provider, queue, deps }
}

const input = (event: CalendarEventLike) => ({
  workspaceId: WS,
  subject: "yossi@acme.co.il",
  calendarEventId: "cal_1",
  meetingId: "meet_google_1",
  event,
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-10-14T08:00:00.000Z"))
  vi.stubEnv("MEETSUM_SESSION_SECRET", "test-session-secret-0123456789")
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("syncCalendarBotSession", () => {
  it("creates a calendar_rule session for an external Teams meeting in a Hebrew description and dispatches at start-60s", async () => {
    const { store, provider, queue, deps } = setup()

    expect(await syncCalendarBotSession(input(calendarEvent()), deps)).toBe("created")

    const session = await store.findByCalendarEvent(WS, "cal_1")

    expect(session).toMatchObject({
      origin: "calendar_rule",
      status: "scheduled",
      platform: "teams",
      nativeMeetingId: "19:meeting_NjY4YzEzMzQtZjBkZS00OTk1LWE4ZjAtMTIzNDU2Nzg5MDEy@thread.v2",
      meetingId: "meet_google_1",
      dispatchAt: "2026-10-14T08:59:00.000Z",
      scheduledStart: "2026-10-14T09:00:00.000Z",
      language: "he",
      botName: "MeetSum Notetaker",
      consentStatus: "pending",
      transcribeEnabled: false,
    })
    expect(session?.meetingUrlRedacted).not.toContain("context")
    expect(openMeetingSecrets(session!.passcodeEnc).teamsContext).toContain("72f988bf")
    expect(queue.jobs[0].payload).toMatchObject({ sessionId: session!.id, rev: 0, workspaceId: WS })

    await vi.advanceTimersByTimeAsync(59 * 60_000 - 1)
    expect(provider.requestBot).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(provider.requestBot).toHaveBeenCalledTimes(1)
    expect((await store.get(session!.id))?.status).toBe("requested")
  })

  it("repeated polls are idempotent", async () => {
    const { store, queue, deps } = setup()

    await syncCalendarBotSession(input(calendarEvent()), deps)
    expect(await syncCalendarBotSession(input(calendarEvent()), deps)).toBe("unchanged")
    expect(store.sessions.size).toBe(1)
    expect(queue.jobs).toHaveLength(1)
  })

  it("a reschedule bumps the rev, removes the old job and the old job is a no-op", async () => {
    const { store, provider, queue, deps } = setup()

    await syncCalendarBotSession(input(calendarEvent()), deps)

    const moved = calendarEvent({
      start: { dateTime: "2026-10-14T11:00:00.000Z" },
      end: { dateTime: "2026-10-14T12:00:00.000Z" },
    })

    expect(await syncCalendarBotSession(input(moved), deps)).toBe("rescheduled")

    const session = (await store.findByCalendarEvent(WS, "cal_1"))!

    expect(session).toMatchObject({ dispatchRev: 1, dispatchAt: "2026-10-14T10:59:00.000Z" })
    expect(queue.port.remove).toHaveBeenCalledWith(`bot.dispatch:${session.id}:0`)

    // Even if the old job had fired, its rev is stale.
    expect((await runDispatch({ sessionId: session.id, rev: 0 }, { store, provider: () => provider, queue: queue.port, config: testBotConfig() })).outcome).toBe("skipped")

    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(provider.requestBot).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    expect(provider.requestBot).toHaveBeenCalledTimes(1)
  })

  it("an opt-out survives later polls", async () => {
    const { store, queue, deps } = setup()

    await syncCalendarBotSession(input(calendarEvent()), deps)

    const session = (await store.findByCalendarEvent(WS, "cal_1"))!

    await store.transition(session.id, { status: "cancelled", reason: "user_opt_out", at: new Date(), source: "api" })

    const moved = calendarEvent({ start: { dateTime: "2026-10-14T09:30:00.000Z" } })

    expect(await syncCalendarBotSession(input(moved), deps)).toBe("times_updated")
    expect(await syncCalendarBotSession(input(moved), deps)).toBe("unchanged")
    expect(await store.findByCalendarEvent(WS, "cal_1")).toMatchObject({
      status: "cancelled",
      statusReason: "user_opt_out",
      scheduledStart: "2026-10-14T09:30:00.000Z",
    })
    expect(store.sessions.size).toBe(1)
    expect(queue.jobs).toHaveLength(1)
  })

  it("leaves live sessions alone", async () => {
    const { store, deps } = setup()

    await syncCalendarBotSession(input(calendarEvent()), deps)

    const session = (await store.findByCalendarEvent(WS, "cal_1"))!

    await store.transition(session.id, { status: "active", at: new Date(), source: "webhook" })
    expect(
      await syncCalendarBotSession(input(calendarEvent({ start: { dateTime: "2026-10-14T09:05:00.000Z" } })), deps)
    ).toBe("unchanged")
    expect((await store.get(session.id))?.status).toBe("active")
  })

  it("skips internal-only meetings under external_only", async () => {
    const { store, deps } = setup()
    const internal = calendarEvent({ attendees: calendarEvent().attendees!.slice(0, 2) })

    expect(await syncCalendarBotSession(input(internal), deps)).toBe("skipped")
    expect(store.sessions.size).toBe(0)
  })

  it("invites the bot account when enabled (non-fatal)", async () => {
    const { deps } = setup()
    const inviteBot = vi.fn(async () => {
      throw new Error("insufficient scope token=abc123")
    })

    await syncCalendarBotSession(input(calendarEvent()), {
      ...deps,
      inviteBot,
      config: testBotConfig({ MEETSUM_BOT_CALENDAR_INVITE: "true" }),
    })
    expect(inviteBot).toHaveBeenCalledWith(expect.objectContaining({ botEmail: "notetaker@acme.co.il" }))
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("abc123")
  })
})

describe("cancelCalendarBotSession", () => {
  it("cancels a scheduled session and removes its job", async () => {
    const { store, provider, queue, deps } = setup()

    await syncCalendarBotSession(input(calendarEvent()), deps)

    const session = (await store.findByCalendarEvent(WS, "cal_1"))!

    expect(await cancelCalendarBotSession({ workspaceId: WS, calendarEventId: "cal_1", reason: "event_cancelled" }, deps)).toBe(
      "cancelled"
    )
    expect(await store.get(session.id)).toMatchObject({ status: "cancelled", statusReason: "event_cancelled" })
    expect(queue.pending()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    expect(provider.requestBot).not.toHaveBeenCalled()
  })

  it("leaves a live session running", async () => {
    const { store, deps } = setup()

    await syncCalendarBotSession(input(calendarEvent()), deps)

    const session = (await store.findByCalendarEvent(WS, "cal_1"))!

    await store.transition(session.id, { status: "active", at: new Date(), source: "webhook" })
    expect(await cancelCalendarBotSession({ workspaceId: WS, calendarEventId: "cal_1", reason: "event_cancelled" }, deps)).toBe(
      "unchanged"
    )
    expect((await store.get(session.id))?.status).toBe("active")
  })
})

describe("rules changes", () => {
  it("turning auto-join off cancels only calendar_rule sessions; turning it on reopens them", async () => {
    let current = rules
    const { store, deps } = setup(() => current)

    await syncCalendarBotSession(input(calendarEvent()), deps)

    const manual = await store.create({
      workspaceId: WS,
      meetingId: "meet_manual",
      origin: "manual",
      platform: "google_meet",
      nativeMeetingId: "abc-defg-hij",
      calendarEventId: "cal_2",
      scheduledStart: "2026-10-14T09:00:00.000Z",
      botName: "MeetSum Notetaker",
    })
    const upcoming = [
      { calendarEventId: "cal_1", meetingId: "meet_google_1", subject: "yossi@acme.co.il", event: calendarEvent() },
      {
        calendarEventId: "cal_2",
        meetingId: "meet_manual",
        subject: "yossi@acme.co.il",
        event: calendarEvent({ description: "https://meet.google.com/abc-defg-hij" }),
      },
    ]
    const listUpcomingEvents = vi.fn(async () => upcoming)

    current = { ...rules, autoJoin: "off" }

    // The manual session only gets its calendar times refreshed.
    expect(await resyncWorkspaceBotSessions(WS, { ...deps, listUpcomingEvents })).toEqual({ cancelled: 1, times_updated: 1 })
    expect(await store.findByCalendarEvent(WS, "cal_1")).toMatchObject({ status: "cancelled", statusReason: "rule_disabled" })
    expect((await store.get(manual.id))?.status).toBe("scheduled")

    current = rules

    expect(await resyncWorkspaceBotSessions(WS, { ...deps, listUpcomingEvents })).toEqual({ reopened: 1, unchanged: 1 })
    expect(await store.findByCalendarEvent(WS, "cal_1")).toMatchObject({ status: "scheduled", dispatchRev: 1 })
  })
})
