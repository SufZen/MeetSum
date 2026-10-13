/**
 * M8 B2: Outlook delta sync on PGlite (migrations 001–027), with recorded
 * Graph fixtures and a fake fetch. M7 bot functions are doubles; the Google
 * side runs the real `pollCalendar` with googleapis mocked, to prove the
 * iCalUID dedupe in both directions (one meeting, one bot session).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { CalendarEventLike } from "@/lib/bot/types"
import {
  OUTLOOK_PREFER_HEADER,
  type OutlookSyncDeps,
  needsFullSync,
  runOutlookCalendarSync,
} from "@/lib/integrations/microsoft/calendar-sync"

import { createFakeFetch, fixture, json } from "./helpers/provider-fake-fetch"
import { createM8Database, type PgLike, seedM8Workspaces } from "./helpers/pglite-m8"

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  googleEvents: [] as unknown[],
  googleBotSync: [] as Array<{ calendarEventId: string; subject: string; meetingId: string }>,
}))

vi.mock("@/lib/db/client", () => ({ getDatabasePool: () => holder.db }))
vi.mock("@/lib/google/auth", () => ({ createDelegatedGoogleClient: async () => ({}) }))
vi.mock("googleapis", () => ({
  google: {
    calendar: () => ({
      calendarList: { list: async () => ({ data: { items: [{ id: "primary", summary: "Work" }] } }) },
      events: { list: async () => ({ data: { items: holder.googleEvents, nextSyncToken: "sync-1" } }) },
    }),
  },
}))
vi.mock("@/lib/settings/app-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/app-settings")>()),
  getAppSettings: async () => ({
    autoProcessImportedMedia: false,
    retainVideoByDefault: false,
    meetingLanguageMode: "he",
    defaultMeetingVisibility: "workspace",
  }),
}))
vi.mock("@/lib/bot/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bot/config")>()),
  isBotEnabled: () => true,
}))
vi.mock("@/lib/bot/calendar-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bot/calendar-sync")>()),
  syncCalendarBotSession: async (input: { calendarEventId: string; subject: string; meetingId: string }) => {
    holder.googleBotSync.push({ calendarEventId: input.calendarEventId, subject: input.subject, meetingId: input.meetingId })
    return "created"
  },
  cancelCalendarBotSession: async () => "unchanged",
}))

type Page = { value: Array<Record<string, unknown>> }

const SHARED_UID = "040000008200E00074C5B7101A82E00800000000SHARED1"
const NOW = new Date("2026-10-13T12:00:00.000Z")
const START_URL = "GET https://graph.microsoft.com/v1.0/me/calendarView/delta?startDateTime="
const PAGE2_URL = "GET https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=page2token"
const DELTA_1 = "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=delta-token-1"

let db: PgLike | undefined

beforeAll(async () => {
  db = await createM8Database()
  if (db) await seedM8Workspaces(db)
  holder.db = db
}, 180_000)

afterAll(async () => {
  await db?.close()
})

beforeEach(() => {
  holder.googleBotSync.length = 0
  holder.googleEvents = []
})

function harness(overrides: Partial<OutlookSyncDeps> & { routes?: Parameters<typeof createFakeFetch>[0] } = {}) {
  const { fetch, calls } = createFakeFetch(
    overrides.routes ?? [
      { match: START_URL, respond: json(fixture("microsoft/delta-page1.json")) },
      { match: PAGE2_URL, respond: json(fixture("microsoft/delta-page2.json")) },
    ]
  )
  const saved: Array<Parameters<OutlookSyncDeps["saveConfig"]>[0]> = []
  const botSync: Array<{ calendarEventId: string; subject: string; meetingId: string; event: CalendarEventLike }> = []
  const botCancel: string[] = []
  const deps: OutlookSyncDeps = {
    db: db as PgLike,
    fetch,
    getAccessToken: async () => "fixture-ms-access-token-AAA",
    workspaceId: "ws_1",
    connectionId: "intc_ms_1",
    userId: "usr_yossi",
    userEmail: "yossi@acme.co.il",
    cursor: {},
    saveConfig: async (patch) => {
      saved.push(patch)
    },
    settings: { defaultMeetingVisibility: "workspace", language: "he" },
    botEnabled: true,
    syncBot: async (input) => {
      botSync.push(input)
    },
    cancelBot: async (input) => {
      botCancel.push(input.calendarEventId)
    },
    now: () => NOW,
    ...overrides,
  }

  return { deps, calls, saved, botSync, botCancel }
}

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await (db as PgLike).query(sql, params)).rows as T[]
}

async function pollGoogle(workspaceId: string, subject: string) {
  const { pollCalendar } = await import("@/lib/google/services")

  return pollCalendar({ workspaceId, subject })
}

function googleEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "google-event-1",
    iCalUID: SHARED_UID,
    status: "confirmed",
    summary: "פגישת היכרות עם לקוח",
    start: { dateTime: "2026-10-14T09:00:00Z" },
    end: { dateTime: "2026-10-14T10:00:00Z" },
    organizer: { email: "dana@acme.co.il" },
    attendees: [
      { email: "dana@acme.co.il", responseStatus: "accepted" },
      { email: "ceo@client.example", responseStatus: "needsAction" },
    ],
    conferenceData: {
      entryPoints: [
        {
          entryPointType: "video",
          uri: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjY4YzEzMzQtZjBkZS00OTk1LWE4ZjAtMTIzNDU2Nzg5MDEy%40thread.v2/0?context=%7b%22Tid%22%3a%2272f988bf-86f1-41af-91ab-2d7cd011db47%22%7d",
        },
      ],
    },
    ...overrides,
  }
}

describe("needsFullSync", () => {
  it("is full without a delta link, daily, and when the window moved more than a day", () => {
    const fresh = { deltaLink: DELTA_1, windowStart: "2026-10-12T12:00:00.000Z", fullSyncAt: "2026-10-13T06:00:00.000Z" }

    expect(needsFullSync({}, NOW, 14)).toBe(true)
    expect(needsFullSync(fresh, NOW, 14)).toBe(false)
    expect(needsFullSync({ ...fresh, fullSyncAt: "2026-10-12T11:00:00.000Z" }, NOW, 14)).toBe(true)
    expect(needsFullSync({ ...fresh, windowStart: "2026-10-10T12:00:00.000Z" }, NOW, 14)).toBe(true)
  })
})

describe("runOutlookCalendarSync (PGlite)", () => {
  it("pages a full delta, writes Outlook rows and meetings, and feeds M7 with the mapped event", async (context) => {
    if (!db) return context.skip("PGlite unavailable")

    const h = harness()
    const stats = await runOutlookCalendarSync(h.deps)

    expect(h.calls.map((call) => call.url)).toEqual([
      expect.stringContaining("/me/calendarView/delta?startDateTime=2026-10-12T12%3A00%3A00.000Z&endDateTime=2026-10-27T12%3A00%3A00.000Z"),
      "https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=page2token",
    ])
    expect(h.calls[0]?.headers.prefer).toBe(OUTLOOK_PREFER_HEADER)
    expect(h.calls[0]?.headers.authorization).toBe("Bearer fixture-ms-access-token-AAA")
    expect(stats).toMatchObject({ full: true, events: 2, meetings: 2, skipped: 1, deduped: 0, errors: 0 })

    const events = await rows<{ provider: string; workspace_id: string; ical_uid: string; meet_link: string | null; raw: unknown }>(
      "select provider, workspace_id, ical_uid, meet_link, raw from calendar_events where integration_connection_id = 'intc_ms_1' order by starts_at"
    )

    expect(events).toHaveLength(2)
    expect(events.every((row) => row.provider === "microsoft" && row.workspace_id === "ws_1")).toBe(true)
    expect(events[0]?.ical_uid).toBe(SHARED_UID)
    expect(events[1]?.meet_link).not.toContain("pwd")
    expect(JSON.stringify(events)).not.toContain("door code")
    expect(JSON.stringify(events)).not.toContain("Board notes")

    const meetings = await rows<{ source: string; owner_user_id: string; visibility: string; status: string; language: string }>(
      `select m.source, m.owner_user_id, m.visibility, m.status, m.language
         from meetings m join calendar_events ce on ce.id = m.calendar_event_id
        where ce.integration_connection_id = 'intc_ms_1' order by ce.starts_at`
    )

    expect(meetings).toEqual([
      { source: "outlook_calendar", owner_user_id: "usr_yossi", visibility: "workspace", status: "scheduled", language: "he" },
      { source: "outlook_calendar", owner_user_id: "usr_yossi", visibility: "private", status: "scheduled", language: "he" },
    ])

    const participants = await rows<{ email: string }>(
      "select email from meeting_participants where meeting_id in (select id from meetings where source = 'outlook_calendar') order by email"
    )

    expect(participants.map((row) => row.email)).not.toContain("room1@acme.co.il")

    expect(h.botSync).toHaveLength(2)
    expect(h.botSync.every((call) => call.subject === "yossi@acme.co.il")).toBe(true)
    expect(h.botSync[0]?.event.conferenceData?.entryPoints?.[0]?.uri).toContain("teams.microsoft.com")
    expect(h.saved[0]?.calendarSync).toMatchObject({ deltaLink: DELTA_1, windowStart: "2026-10-12T12:00:00.000Z", fullSyncAt: NOW.toISOString() })
    expect(h.saved[0]?.lastSync).toMatchObject({ events: 2, meetings: 2, errors: 0 })
    expect(JSON.stringify(h.saved)).not.toContain("fixture-ms-access-token")
  })

  it("Outlook first, then Google: the Google row reuses the meeting and syncs no bot", async (context) => {
    if (!db) return context.skip("PGlite unavailable")

    holder.googleEvents = [googleEvent()]
    await pollGoogle("ws_1", "dana@acme.co.il")

    const sameMeeting = await rows<{ provider: string; meeting_id: string | null }>(
      `select ce.provider, m.id as meeting_id from calendar_events ce
         left join meetings m on m.calendar_event_id = ce.id
        where ce.workspace_id = 'ws_1' and ce.ical_uid = $1 order by ce.provider`,
      [SHARED_UID]
    )

    expect(sameMeeting).toEqual([
      { provider: "google", meeting_id: null },
      { provider: "microsoft", meeting_id: expect.stringMatching(/^meet_outlook_/) },
    ])
    expect(holder.googleBotSync).toEqual([])

    // A re-run of the Outlook sync keeps it canonical: still one meeting, one bot sync per run.
    const again = harness()

    await runOutlookCalendarSync(again.deps)
    expect(again.botSync.filter((call) => call.calendarEventId.startsWith("mscal_"))).toHaveLength(2)
    expect((await rows("select id from meetings where workspace_id = 'ws_1' and calendar_event_id in (select id from calendar_events where ical_uid = $1)", [SHARED_UID])).length).toBe(1)
  })

  it("applies @removed from an incremental delta as a cancellation", async (context) => {
    if (!db) return context.skip("PGlite unavailable")

    const h = harness({
      cursor: { deltaLink: DELTA_1, windowStart: "2026-10-12T12:00:00.000Z", windowEnd: "2026-10-27T12:00:00.000Z", fullSyncAt: "2026-10-13T11:00:00.000Z" },
      routes: [{ match: `GET ${DELTA_1}`, respond: json(fixture("microsoft/delta-incremental.json")) }],
    })
    const stats = await runOutlookCalendarSync(h.deps)

    expect(stats).toMatchObject({ full: false, cancelled: 1 })
    expect(h.calls).toHaveLength(1)
    expect(h.botCancel).toHaveLength(1)

    const zoom = await rows<{ status: string; meeting_status: string }>(
      `select ce.status, m.status as meeting_status from calendar_events ce join meetings m on m.calendar_event_id = ce.id
        where ce.external_event_id = 'AAMkAGzoom1'`
    )

    expect(zoom).toEqual([{ status: "cancelled", meeting_status: "failed" }])
    expect(h.saved[0]?.calendarSync.deltaLink).toContain("delta-token-2")
    expect(h.saved[0]?.calendarSync.fullSyncAt).toBe("2026-10-13T11:00:00.000Z")
  })

  it("restarts a full sync on 410 syncStateNotFound", async (context) => {
    if (!db) return context.skip("PGlite unavailable")

    const h = harness({
      cursor: { deltaLink: DELTA_1, windowStart: "2026-10-12T12:00:00.000Z", windowEnd: "2026-10-27T12:00:00.000Z", fullSyncAt: "2026-10-13T11:00:00.000Z" },
      routes: [
        { match: `GET ${DELTA_1}`, respond: json(fixture("microsoft/delta-gone.json"), 410) },
        { match: START_URL, respond: json({ ...fixture<Page>("microsoft/delta-page2.json") }) },
      ],
    })
    const stats = await runOutlookCalendarSync(h.deps)

    expect(stats.full).toBe(true)
    expect(h.calls.map((call) => call.url.split("?")[1]?.slice(0, 14))).toEqual(["$deltatoken=de", "startDateTime="])
    expect(h.saved[0]?.calendarSync.fullSyncAt).toBe(NOW.toISOString())
  })

  it("Google first, then Outlook (another workspace): one meeting, one bot session, no cross-workspace dedupe", async (context) => {
    if (!db) return context.skip("PGlite unavailable")

    holder.googleEvents = [googleEvent({ id: "google-event-w2" })]
    await pollGoogle("ws_2", "other@w2.example")

    // W1 already has an Outlook meeting with this iCalUID; W2 still gets its own.
    expect(holder.googleBotSync).toHaveLength(1)
    expect(holder.googleBotSync[0]?.subject).toBe("other@w2.example")

    const h = harness({ workspaceId: "ws_2", connectionId: "intc_ms_w2", userId: "usr_w2", userEmail: "other@w2.example" })
    const stats = await runOutlookCalendarSync(h.deps)

    expect(stats.deduped).toBe(1)
    expect(h.botSync.map((call) => call.event.summary)).toEqual(["Quarterly review"])

    const w2 = await rows<{ provider: string; meeting_id: string | null }>(
      `select ce.provider, m.id as meeting_id from calendar_events ce left join meetings m on m.calendar_event_id = ce.id
        where ce.workspace_id = 'ws_2' and ce.ical_uid = $1 order by ce.provider`,
      [SHARED_UID]
    )

    expect(w2).toEqual([
      { provider: "google", meeting_id: expect.stringMatching(/^meet_google_/) },
      { provider: "microsoft", meeting_id: null },
    ])
  })

  it("does not dedupe a recurring Google series instance at another start time", async (context) => {
    if (!db) return context.skip("PGlite unavailable")

    holder.googleEvents = [
      googleEvent({ id: "google-event-w2_next", start: { dateTime: "2026-10-21T09:00:00Z" }, end: { dateTime: "2026-10-21T10:00:00Z" } }),
    ]
    await pollGoogle("ws_2", "other@w2.example")
    expect(holder.googleBotSync).toHaveLength(1)
  })
})
