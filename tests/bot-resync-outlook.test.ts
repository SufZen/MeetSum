/**
 * M8 B2 "M7 resync": `listUpcomingCalendarEvents` (behind
 * `defaultUpcomingEvents`) unions canonical Outlook rows of active Microsoft
 * connections with the Google rows, scoped by workspace.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { listUpcomingCalendarEvents } from "@/lib/bot/calendar-sync"

import { createM8Database, type PgLike, seedM8Workspaces } from "./helpers/pglite-m8"

let db: PgLike | undefined

const WINDOW = { from: new Date("2026-10-13T00:00:00.000Z"), to: new Date("2026-10-27T00:00:00.000Z") }

beforeAll(async () => {
  db = await createM8Database()
  if (!db) return
  await seedM8Workspaces(db)
  await db.exec(`
    insert into workspace_accounts (id, domain, admin_email) values ('wa_1', 'acme.co.il', 'dana@acme.co.il');
    insert into google_identities (id, workspace_account_id, subject_email, workspace_id)
      values ('gi_1', 'wa_1', 'dana@acme.co.il', 'ws_1');

    insert into calendar_events (id, provider, google_identity_id, google_event_id, workspace_id, ical_uid, title, starts_at, raw)
      values ('ce_google', 'google', 'gi_1', 'g1', 'ws_1', 'uid-g', 'Google', '2026-10-14T08:00:00Z', '{"summary":"Google"}');
    insert into calendar_events (id, provider, workspace_id, integration_connection_id, external_event_id, ical_uid, title, starts_at, raw) values
      ('ce_ms_canonical', 'microsoft', 'ws_1', 'intc_ms_1', 'e1', 'uid-1', 'Outlook', '2026-10-14T09:00:00Z', '{"summary":"Outlook"}'),
      ('ce_ms_duplicate', 'microsoft', 'ws_1', 'intc_ms_1', 'e2', 'uid-g', 'Dup of Google', '2026-10-14T08:00:00Z', '{"summary":"Dup"}'),
      ('ce_ms_revoked', 'microsoft', 'ws_1', 'intc_ms_revoked', 'e3', 'uid-3', 'Revoked', '2026-10-14T10:00:00Z', '{"summary":"Revoked"}'),
      ('ce_ms_past', 'microsoft', 'ws_1', 'intc_ms_1', 'e4', 'uid-4', 'Past', '2026-10-01T10:00:00Z', '{"summary":"Past"}'),
      ('ce_ms_w2', 'microsoft', 'ws_2', 'intc_ms_w2', 'e5', 'uid-5', 'W2', '2026-10-14T11:00:00Z', '{"summary":"W2"}');

    insert into meetings (id, calendar_event_id, title, source, status, started_at, workspace_id) values
      ('m_google', 'ce_google', 'Google', 'google_meet', 'scheduled', '2026-10-14T08:00:00Z', 'ws_1'),
      ('m_ms', 'ce_ms_canonical', 'Outlook', 'outlook_calendar', 'scheduled', '2026-10-14T09:00:00Z', 'ws_1'),
      ('m_revoked', 'ce_ms_revoked', 'Revoked', 'outlook_calendar', 'scheduled', '2026-10-14T10:00:00Z', 'ws_1'),
      ('m_past', 'ce_ms_past', 'Past', 'outlook_calendar', 'scheduled', '2026-10-01T10:00:00Z', 'ws_1'),
      ('m_w2', 'ce_ms_w2', 'W2', 'outlook_calendar', 'scheduled', '2026-10-14T11:00:00Z', 'ws_2');
  `)
}, 180_000)

afterAll(async () => {
  await db?.close()
})

describe("listUpcomingCalendarEvents", () => {
  it("returns Google and canonical Outlook rows with the right subject, skipping revoked and non-canonical rows", async (context) => {
    if (!db) return context.skip("PGlite unavailable")

    const events = await listUpcomingCalendarEvents(db, "ws_1", WINDOW)

    expect(events).toEqual([
      { calendarEventId: "ce_google", meetingId: "m_google", subject: "dana@acme.co.il", event: { summary: "Google" } },
      { calendarEventId: "ce_ms_canonical", meetingId: "m_ms", subject: "yossi@acme.co.il", event: { summary: "Outlook" } },
    ])
  })

  it("is scoped by workspace", async (context) => {
    if (!db) return context.skip("PGlite unavailable")

    const events = await listUpcomingCalendarEvents(db, "ws_2", WINDOW)

    expect(events.map((event) => event.calendarEventId)).toEqual(["ce_ms_w2"])
    expect(events[0]?.subject).toBe("other@w2.example")
  })
})
