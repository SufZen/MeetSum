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

const TEAMS_REAL =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_UmVhbE1lZXRpbmdEYW5hMDAwMDAwMDAwMDAwMDAwMA%40thread.v2/0?context=%7b%22Tid%22%3a%2272f988bf-86f1-41af-91ab-2d7cd011db47%22%7d"
const ZOOM_ATTACKER = "https://evil-corp.zoom.us/j/99988877766?pwd=attacker"

function graphInvite(uid: string, start: string, overrides: Record<string, unknown> = {}) {
  const end = new Date(Date.parse(`${start}Z`) + 3_600_000).toISOString().replace("Z", "")

  return {
    id: `ev-${uid}`,
    iCalUId: uid,
    subject: `Invite ${uid}`,
    isCancelled: false,
    isAllDay: false,
    sensitivity: "normal",
    start: { dateTime: start, timeZone: "UTC" },
    end: { dateTime: end, timeZone: "UTC" },
    organizer: { emailAddress: { name: "Dana", address: "dana@acme.co.il" } },
    attendees: [{ type: "required", status: { response: "none" }, emailAddress: { address: "ceo@client.example" } }],
    body: { contentType: "text", content: "" },
    onlineMeeting: { joinUrl: TEAMS_REAL },
    ...overrides,
  }
}

function singlePage(events: unknown[]) {
  return [{ match: START_URL, respond: json({ "@odata.deltaLink": DELTA_1, value: events }) }]
}

/** Dana's own Google calendar row + meeting (DWD subject). */
async function seedDanaGoogleMeeting(uid: string, start: string, visibility: "private" | "workspace") {
  await (db as PgLike).exec(`
    insert into workspace_accounts (id, domain, admin_email) values ('wa_sec', 'acme.co.il', 'dana@acme.co.il') on conflict do nothing;
    insert into google_identities (id, workspace_account_id, subject_email, workspace_id)
      values ('gi_sec', 'wa_sec', 'dana-sec@acme.co.il', 'ws_1') on conflict do nothing;
  `)
  await (db as PgLike).query(
    `insert into calendar_events (id, provider, google_identity_id, google_event_id, workspace_id, ical_uid, title, starts_at, organizer_email, raw)
     values ($1, 'google', 'gi_sec', $1, 'ws_1', $2, 'Dana real meeting', $3, 'dana@acme.co.il', $4::jsonb)`,
    [`ce_dana_${uid}`, uid, `${start}Z`, JSON.stringify({ conferenceData: { entryPoints: [{ entryPointType: "video", uri: TEAMS_REAL }] } })]
  )
  await (db as PgLike).query(
    `insert into meetings (id, calendar_event_id, title, source, status, started_at, workspace_id, owner_user_id, visibility)
     values ($1, $2, 'Dana real meeting', 'google_meet', 'scheduled', $3, 'ws_1', 'usr_dana', $4)`,
    [`m_dana_${uid}`, `ce_dana_${uid}`, `${start}Z`, visibility]
  )
}

async function meetingsForUid(uid: string) {
  return rows<{ id: string; owner_user_id: string; visibility: string; title: string }>(
    `select m.id, m.owner_user_id, m.visibility, m.title from meetings m join calendar_events ce on ce.id = m.calendar_event_id
      where ce.workspace_id = 'ws_1' and ce.ical_uid = $1 order by m.id`,
    [uid]
  )
}

const attackerBody = { onlineMeeting: null, body: { contentType: "text", content: `Join ${ZOOM_ATTACKER}` } }

describe("iCalUID dedupe safety (security review)", () => {
  it("never adopts another user's PRIVATE meeting with the same iCalUID: both keep their own meeting", async (context) => {
    if (!db) return context.skip("PGlite unavailable")

    await seedDanaGoogleMeeting("uid-private", "2026-10-20T09:00:00", "private")

    const h = harness({ routes: singlePage([graphInvite("uid-private", "2026-10-20T09:00:00")]) })
    const stats = await runOutlookCalendarSync(h.deps)

    expect(stats.deduped).toBe(0)
    expect(h.botSync).toHaveLength(1)
    expect(await meetingsForUid("uid-private")).toEqual([
      { id: "m_dana_uid-private", owner_user_id: "usr_dana", visibility: "private", title: "Dana real meeting" },
      expect.objectContaining({ owner_user_id: "usr_yossi", id: expect.stringMatching(/^meet_outlook_/) }),
    ])
  })

  it("dedupes two members' rows when the meeting is workspace-visible with the same organizer and link", async (context) => {
    if (!db) return context.skip("PGlite unavailable")

    await seedDanaGoogleMeeting("uid-visible", "2026-10-20T11:00:00", "workspace")

    const h = harness({ routes: singlePage([graphInvite("uid-visible", "2026-10-20T11:00:00")]) })
    const stats = await runOutlookCalendarSync(h.deps)

    expect(stats.deduped).toBe(1)
    expect(h.botSync).toHaveLength(0)
    expect((await meetingsForUid("uid-visible")).map((meeting) => meeting.id)).toEqual(["m_dana_uid-visible"])
  })

  it("does not dedupe a visible meeting when the organizer differs", async (context) => {
    if (!db) return context.skip("PGlite unavailable")

    await seedDanaGoogleMeeting("uid-other-org", "2026-10-20T15:00:00", "workspace")

    const h = harness({
      routes: singlePage([
        graphInvite("uid-other-org", "2026-10-20T15:00:00", { organizer: { emailAddress: { address: "mallory@evil.example" } } }),
      ]),
    })

    expect((await runOutlookCalendarSync(h.deps)).deduped).toBe(0)
    expect(await meetingsForUid("uid-other-org")).toHaveLength(2)
  })

  it("a forged external invite (same iCalUID, start and organizer, another link) never suppresses or takes over the real meeting", async (context) => {
    if (!db) return context.skip("PGlite unavailable")

    await seedDanaGoogleMeeting("uid-forged", "2026-10-20T13:00:00", "workspace")

    const h = harness({ routes: singlePage([graphInvite("uid-forged", "2026-10-20T13:00:00", attackerBody)]) })
    const stats = await runOutlookCalendarSync(h.deps)

    expect(stats.deduped).toBe(0)
    expect(h.botSync.map((call) => call.subject)).toEqual(["yossi@acme.co.il"])

    const meetings = await meetingsForUid("uid-forged")

    expect(meetings).toHaveLength(2)
    expect(meetings[0]).toEqual({ id: "m_dana_uid-forged", owner_user_id: "usr_dana", visibility: "workspace", title: "Dana real meeting" })
  })

  it("a forged invite synced FIRST does not swallow the real Google meeting synced later", async (context) => {
    if (!db) return context.skip("PGlite unavailable")

    const h = harness({ routes: singlePage([graphInvite("uid-forged-first", "2026-10-21T09:00:00", attackerBody)]) })

    await runOutlookCalendarSync(h.deps)

    holder.googleEvents = [
      googleEvent({
        id: "google-real-forged-first",
        iCalUID: "uid-forged-first",
        start: { dateTime: "2026-10-21T09:00:00Z" },
        end: { dateTime: "2026-10-21T10:00:00Z" },
        conferenceData: { entryPoints: [{ entryPointType: "video", uri: TEAMS_REAL }] },
      }),
    ]
    await pollGoogle("ws_1", "dana@acme.co.il")

    expect(holder.googleBotSync).toHaveLength(1)
    expect(holder.googleBotSync[0]?.subject).toBe("dana@acme.co.il")
    expect(await meetingsForUid("uid-forged-first")).toHaveLength(2)
  })
})

/**
 * Parity: the same dedupe cases run against BOTH sync paths (they share
 * `findCanonicalMeetingId`). The existing meeting always belongs to the
 * other provider and, unless stated, to the other user.
 */
type ParityCase = {
  name: string
  existingOwner: "other" | "self"
  existingWorkspace?: "ws_1" | "ws_2"
  visibility: "private" | "workspace"
  organizer?: string
  attackerLink?: boolean
  deduped: boolean
}

const PARITY_CASES: ParityCase[] = [
  { name: "another member's private meeting", existingOwner: "other", visibility: "private", deduped: false },
  { name: "a visible meeting with the same organizer and link", existingOwner: "other", visibility: "workspace", deduped: true },
  { name: "the same principal's own private meeting", existingOwner: "self", visibility: "private", deduped: true },
  { name: "a visible meeting with another organizer", existingOwner: "other", visibility: "workspace", organizer: "mallory@evil.example", deduped: false },
  { name: "a forged UID carrying another meeting link", existingOwner: "other", visibility: "workspace", attackerLink: true, deduped: false },
  { name: "the same UID in another workspace", existingOwner: "other", existingWorkspace: "ws_2", visibility: "workspace", deduped: false },
]

const PARITY_USERS = {
  outlook: { userId: "usr_yossi", email: "yossi@acme.co.il", other: "usr_dana" },
  google: { userId: "usr_dana", email: "dana@acme.co.il", other: "usr_yossi" },
} as const

async function seedExisting(path: "outlook" | "google", uid: string, start: string, parity: ParityCase) {
  const users = PARITY_USERS[path]
  const owner = parity.existingOwner === "self" ? users.userId : users.other
  const workspace = parity.existingWorkspace ?? "ws_1"
  const ceId = `ce_par_${path}_${uid}`
  const raw = JSON.stringify({ conferenceData: { entryPoints: [{ entryPointType: "video", uri: TEAMS_REAL }] } })

  if (path === "outlook") {
    // Existing = a Google row (other provider).
    await (db as PgLike).exec(`
      insert into workspace_accounts (id, domain, admin_email) values ('wa_par_${workspace}', 'acme.co.il', 'x@acme.co.il') on conflict do nothing;
      insert into google_identities (id, workspace_account_id, subject_email, workspace_id)
        values ('gi_par_${workspace}', 'wa_par_${workspace}', 'par@acme.co.il', '${workspace}') on conflict do nothing;
    `)
    await (db as PgLike).query(
      `insert into calendar_events (id, provider, google_identity_id, google_event_id, workspace_id, ical_uid, title, starts_at, organizer_email, raw)
       values ($1, 'google', $2, $1, $3, $4, 'Existing', $5, 'dana@acme.co.il', $6::jsonb)`,
      [ceId, `gi_par_${workspace}`, workspace, uid, `${start}Z`, raw]
    )
  } else {
    // Existing = an Outlook row (other provider).
    const connection = workspace === "ws_2" ? "intc_ms_w2" : "intc_ms_1"

    await (db as PgLike).query(
      `insert into calendar_events (id, provider, workspace_id, integration_connection_id, external_event_id, ical_uid, title, starts_at, organizer_email, raw)
       values ($1, 'microsoft', $2, $3, $1, $4, 'Existing', $5, 'dana@acme.co.il', $6::jsonb)`,
      [ceId, workspace, connection, uid, `${start}Z`, raw]
    )
  }

  await (db as PgLike).query(
    `insert into meetings (id, calendar_event_id, title, source, status, started_at, workspace_id, owner_user_id, visibility)
     values ($1, $2, 'Existing', 'google_meet', 'scheduled', $3, $4, $5, $6)`,
    [`m_par_${path}_${uid}`, ceId, `${start}Z`, workspace, workspace === "ws_2" ? "usr_w2" : owner, parity.visibility]
  )
}

async function syncIncoming(path: "outlook" | "google", uid: string, start: string, parity: ParityCase) {
  const organizer = parity.organizer ?? "dana@acme.co.il"

  if (path === "outlook") {
    const h = harness({
      routes: singlePage([
        graphInvite(uid, start, {
          organizer: { emailAddress: { address: organizer } },
          ...(parity.attackerLink ? attackerBody : {}),
        }),
      ]),
    })
    const stats = await runOutlookCalendarSync(h.deps)

    return { deduped: stats.deduped === 1, botSyncs: h.botSync.length }
  }

  holder.googleEvents = [
    googleEvent({
      id: `google-${uid}`,
      iCalUID: uid,
      organizer: { email: organizer },
      start: { dateTime: `${start}Z` },
      end: { dateTime: new Date(Date.parse(`${start}Z`) + 3_600_000).toISOString() },
      conferenceData: { entryPoints: [{ entryPointType: "video", uri: parity.attackerLink ? ZOOM_ATTACKER : TEAMS_REAL }] },
    }),
  ]
  await pollGoogle("ws_1", PARITY_USERS.google.email)

  const own = await rows(
    `select m.id from meetings m join calendar_events ce on ce.id = m.calendar_event_id
      where ce.provider = 'google' and ce.google_event_id = $1 and m.workspace_id = 'ws_1'`,
    [`google-${uid}`]
  )

  return { deduped: own.length === 0, botSyncs: holder.googleBotSync.length }
}

describe.each(["outlook", "google"] as const)("dedupe parity: %s path", (path) => {
  PARITY_CASES.forEach((parity, index) => {
    it(`${parity.deduped ? "dedupes" : "keeps both for"} ${parity.name}`, async (context) => {
      if (!db) return context.skip("PGlite unavailable")

      const uid = `uid-par-${index}`
      const start = `2026-10-2${path === "outlook" ? 3 : 4}T${String(8 + index).padStart(2, "0")}:00:00`

      await seedExisting(path, uid, start, parity)

      const result = await syncIncoming(path, uid, start, parity)

      expect(result.deduped).toBe(parity.deduped)
      expect(result.botSyncs).toBe(parity.deduped ? 0 : 1)

      // The existing meeting is never modified or re-owned.
      const existing = await rows<{ title: string; owner_user_id: string; visibility: string; workspace_id: string }>(
        "select title, owner_user_id, visibility, workspace_id from meetings where id = $1",
        [`m_par_${path}_${uid}`]
      )

      expect(existing[0]).toMatchObject({ title: "Existing", visibility: parity.visibility, workspace_id: parity.existingWorkspace ?? "ws_1" })
    })
  })
})

/**
 * M8 review fixes #7/#8: the Google path mirrors the Outlook dedupe tests;
 * a concurrent first sync of both calendars creates exactly one meeting;
 * any failure in the dedupe path fails closed (no meeting, no bot); a
 * cancelled canonical event leaves the duplicate skipped (documented
 * limitation: no promotion).
 */
describe("Google dedupe path, concurrency and fail-closed (review fixes)", () => {
  function sharedGoogleEvent(uid: string, start: string, overrides: Record<string, unknown> = {}) {
    return googleEvent({
      id: `google-${uid}`,
      iCalUID: uid,
      start: { dateTime: `${start}Z` },
      end: { dateTime: new Date(Date.parse(`${start}Z`) + 3_600_000).toISOString() },
      conferenceData: { entryPoints: [{ entryPointType: "video", uri: TEAMS_REAL }] },
      ...overrides,
    })
  }

  /** The PGlite connection with one kind of query failing. */
  function failingDb(pattern: RegExp): PgLike {
    const real = db as PgLike

    return {
      exec: (sql) => real.exec(sql),
      close: () => real.close(),
      query: async (sql, params) => {
        if (pattern.test(sql)) throw new Error("injected failure")
        return real.query(sql, params)
      },
    }
  }

  it("Google first, then Outlook (same workspace): the Outlook row reuses the meeting; a Google re-run keeps it canonical", async (context) => {
    if (!db) return context.skip("PGlite unavailable")

    holder.googleEvents = [sharedGoogleEvent("uid-g-first", "2026-10-25T09:00:00")]
    await pollGoogle("ws_1", "dana@acme.co.il")
    expect(holder.googleBotSync).toHaveLength(1)

    const h = harness({ routes: singlePage([graphInvite("uid-g-first", "2026-10-25T09:00:00")]) })
    const stats = await runOutlookCalendarSync(h.deps)

    expect(stats.deduped).toBe(1)
    expect(h.botSync).toHaveLength(0)

    await pollGoogle("ws_1", "dana@acme.co.il")
    expect(holder.googleBotSync).toHaveLength(2)
    expect(holder.googleBotSync.every((call) => call.calendarEventId.startsWith("gcal_"))).toBe(true)
    expect(await meetingsForUid("uid-g-first")).toHaveLength(1)
  })

  it("a cancelled Google event cancels its own meeting", async (context) => {
    if (!db) return context.skip("PGlite unavailable")

    holder.googleEvents = [sharedGoogleEvent("uid-g-cancel", "2026-10-25T11:00:00")]
    await pollGoogle("ws_1", "dana@acme.co.il")
    holder.googleEvents = [sharedGoogleEvent("uid-g-cancel", "2026-10-25T11:00:00", { status: "cancelled" })]
    const stats = await pollGoogle("ws_1", "dana@acme.co.il")

    expect(stats.cancelled).toBe(1)
    expect(
      await rows<{ status: string }>(
        "select m.status from meetings m join calendar_events ce on ce.id = m.calendar_event_id where ce.google_event_id = $1",
        ["google-uid-g-cancel"]
      )
    ).toEqual([{ status: "failed" }])
  })

  it("a concurrent first sync of both calendars creates exactly one meeting", async (context) => {
    if (!db) return context.skip("PGlite unavailable")

    const uid = "uid-concurrent"
    const start = "2026-10-26T09:00:00"

    holder.googleEvents = [sharedGoogleEvent(uid, start)]
    const h = harness({ routes: singlePage([graphInvite(uid, start)]) })

    await Promise.all([pollGoogle("ws_1", "dana@acme.co.il"), runOutlookCalendarSync(h.deps)])

    expect(await meetingsForUid(uid)).toHaveLength(1)
    expect(holder.googleBotSync.length + h.botSync.length).toBe(1)
  })

  it.each([
    ["the dedupe lock", /pg_advisory_lock/],
    ["the canonical lookup", /from calendar_events ce\s+join meetings m/],
    ["the meeting insert", /insert into meetings/],
  ])("a failure of %s creates no meeting and no bot (fail closed, reason recorded)", async (_label, pattern, context) => {
    if (!db) return context.skip("PGlite unavailable")

    const uid = `uid-fail-${String(pattern).length}`
    const h = harness({ db: failingDb(pattern), routes: singlePage([graphInvite(uid, "2026-10-26T11:00:00")]) })
    const stats = await runOutlookCalendarSync(h.deps)

    expect(stats.meetings).toBe(0)
    expect(stats.dedupeFailures).toBe(1)
    expect(h.botSync).toHaveLength(0)
    expect(await meetingsForUid(uid)).toEqual([])
  })

  it("a cancelled canonical event creates no new meeting and no bot for the duplicate", async (context) => {
    if (!db) return context.skip("PGlite unavailable")

    const uid = "uid-cancelled-canonical"
    const start = "2026-10-26T13:00:00"

    await runOutlookCalendarSync(harness({ routes: singlePage([graphInvite(uid, start)]) }).deps)
    holder.googleEvents = [sharedGoogleEvent(uid, start)]
    await pollGoogle("ws_1", "dana@acme.co.il")

    // The canonical Outlook event is cancelled; the Google copy is synced again.
    await runOutlookCalendarSync(harness({ routes: singlePage([graphInvite(uid, start, { isCancelled: true })]) }).deps)
    await pollGoogle("ws_1", "dana@acme.co.il")
    holder.googleEvents = []
    await pollGoogle("ws_1", "dana@acme.co.il")

    expect(holder.googleBotSync).toEqual([])
    expect(
      await rows<{ provider: string; status: string }>(
        `select ce.provider, m.status from meetings m join calendar_events ce on ce.id = m.calendar_event_id
          where ce.ical_uid = $1`,
        [uid]
      )
    ).toEqual([{ provider: "microsoft", status: "failed" }])
  })
})
