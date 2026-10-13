/**
 * M8 B2: Outlook events go through the real M7 rule evaluation
 * (`syncCalendarBotSession`) exactly like Google rows: external-only rules,
 * consent, owner-only by subject, and the user's own opt-out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { type CalendarSyncDeps, syncCalendarBotSession } from "@/lib/bot/calendar-sync"
import { createMemoryBotSessionStore } from "@/lib/bot/store-memory"
import { type BotRules, DEFAULT_BOT_RULES } from "@/lib/bot/types"
import { type GraphEvent, mapGraphEventToCalendarEventLike } from "@/lib/integrations/microsoft/calendar-map"

import { fakeQueue } from "./fixtures/vexa/api/harness"
import { testBotConfig } from "./fixtures/vexa/api/harness"
import { fixture } from "./helpers/provider-fake-fetch"

const WS = "ws_1"
const teams = fixture<{ value: GraphEvent[] }>("microsoft/delta-page1.json").value[0] as GraphEvent

function rules(overrides: Partial<BotRules> = {}): BotRules {
  return {
    ...DEFAULT_BOT_RULES,
    consentMessage: { ...DEFAULT_BOT_RULES.consentMessage },
    autoJoin: "external_only",
    consentAcknowledgedAt: "2026-10-01T00:00:00.000Z",
    consentAcknowledgedByUserId: "usr_dana",
    ...overrides,
  }
}

function setup(botRules: BotRules) {
  const store = createMemoryBotSessionStore()
  const queue = fakeQueue(() => undefined)
  const deps: Partial<CalendarSyncDeps> = {
    store,
    queue: queue.port,
    config: testBotConfig(),
    getRules: async () => botRules,
    listMemberEmails: async () => ["dana@acme.co.il", "yossi@acme.co.il"],
    getMeetingLanguage: async () => "he",
    inviteBot: vi.fn(async () => undefined),
  }

  return { store, deps }
}

function outlook(event: GraphEvent) {
  const mapped = mapGraphEventToCalendarEventLike(event, { selfEmail: "yossi@acme.co.il" })

  return {
    workspaceId: WS,
    subject: "yossi@acme.co.il",
    calendarEventId: "mscal_1",
    meetingId: "meet_outlook_1",
    event: mapped!.event,
  }
}

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

describe("M7 rules on Outlook rows", () => {
  it("schedules a calendar_rule Teams session for an external Outlook meeting, with consent pending", async () => {
    const { store, deps } = setup(rules())

    expect(await syncCalendarBotSession(outlook(teams), deps)).toBe("created")
    expect(await store.findByCalendarEvent(WS, "mscal_1")).toMatchObject({
      origin: "calendar_rule",
      platform: "teams",
      meetingId: "meet_outlook_1",
      consentStatus: "pending",
      scheduledStart: "2026-10-14T09:00:00.000Z",
    })
  })

  it("skips an internal-only Outlook meeting under external_only, and everything when auto-join is off", async () => {
    const internal: GraphEvent = {
      ...teams,
      attendees: (teams.attendees ?? []).filter((attendee) => attendee.emailAddress?.address?.endsWith("acme.co.il")),
    }

    expect(await syncCalendarBotSession(outlook(internal), setup(rules()).deps)).toBe("skipped")
    expect(await syncCalendarBotSession(outlook(teams), setup(rules({ autoJoin: "off" })).deps)).toBe("skipped")
  })

  it("owner_only behaves as on Google: a member-organized Outlook meeting joins, an external organizer does not", async () => {
    expect(await syncCalendarBotSession(outlook(teams), setup(rules({ autoJoin: "owner_only" })).deps)).toBe("created")

    const externalOrganizer: GraphEvent = { ...teams, organizer: { emailAddress: { address: "mallory@evil.example" } } }

    expect(await syncCalendarBotSession(outlook(externalOrganizer), setup(rules({ autoJoin: "owner_only" })).deps)).toBe("skipped")
  })

  it("never joins when the workspace has not acknowledged recording consent", async () => {
    expect(await syncCalendarBotSession(outlook(teams), setup(rules({ consentAcknowledgedAt: null })).deps)).toBe("skipped")
  })
})
