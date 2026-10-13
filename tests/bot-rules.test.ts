import { describe, expect, it } from "vitest"

import { getBotConfig } from "@/lib/bot/config"
import { parseMeetingLink } from "@/lib/bot/meeting-url"
import {
  type AutoJoinInput,
  ensureRecordingBotName,
  evaluateAutoJoin,
  resolveBotLanguage,
  resolveInternalDomains,
} from "@/lib/bot/rules"
import { type BotRules, type CalendarEventLike, DEFAULT_BOT_RULES } from "@/lib/bot/types"

const NOW = new Date("2026-10-14T08:00:00.000Z")
const START = "2026-10-14T09:00:00.000Z"
const END = "2026-10-14T10:00:00.000Z"
const config = getBotConfig({
  MEETSUM_BOT_ENABLED: "true",
  MEETSUM_BOT_ACCOUNT_EMAIL: "notetaker@acme.co.il",
  MEETSUM_BOT_INTERNAL_DOMAINS: "acme-labs.com",
})
const rules: BotRules = {
  ...DEFAULT_BOT_RULES,
  consentMessage: { ...DEFAULT_BOT_RULES.consentMessage },
  autoJoin: "all",
  consentAcknowledgedAt: "2026-10-01T00:00:00.000Z",
  consentAcknowledgedByUserId: "user_admin",
}
const event: CalendarEventLike = {
  id: "evt1",
  status: "confirmed",
  summary: "סנכרון שבועי",
  start: { dateTime: START },
  end: { dateTime: END },
  organizer: { email: "dana@acme.co.il" },
  attendees: [
    { email: "dana@acme.co.il", responseStatus: "accepted", organizer: true },
    { email: "yossi@acme.co.il", responseStatus: "needsAction", self: true },
  ],
}
const members = ["dana@acme.co.il", "yossi@acme.co.il"]

function input(overrides: Partial<AutoJoinInput> = {}): AutoJoinInput {
  const merged = { rules, event, members, subject: "yossi@acme.co.il", now: NOW, config, ...overrides }

  return {
    link: parseMeetingLink("https://meet.google.com/abc-defg-hij"),
    internalDomains: resolveInternalDomains(merged.members, config, merged.rules),
    ...merged,
  }
}

describe("evaluateAutoJoin", () => {
  it("joins with dispatchAt = start - lead", () => {
    expect(evaluateAutoJoin(input())).toEqual({
      join: true,
      dispatchAt: new Date("2026-10-14T08:59:00.000Z"),
    })
    expect(
      evaluateAutoJoin(input({ rules: { ...rules, joinLeadSeconds: 0 } }))
    ).toMatchObject({ dispatchAt: new Date(START) })
  })

  it("dispatches immediately when the lead time already passed", () => {
    const now = new Date("2026-10-14T08:59:30.000Z")

    expect(evaluateAutoJoin(input({ now }))).toEqual({ join: true, dispatchAt: now })
  })

  it("is off by default and gated on the consent acknowledgment", () => {
    expect(evaluateAutoJoin(input({ rules: { ...DEFAULT_BOT_RULES } }))).toEqual({
      join: false,
      reason: "rule_disabled",
    })
    expect(
      evaluateAutoJoin(input({ rules: { ...rules, consentAcknowledgedAt: null } }))
    ).toEqual({ join: false, reason: "rule_disabled" })
  })

  it.each([
    ["no link", { link: undefined }, "no_link"],
    ["all-day", { event: { ...event, start: { date: "2026-10-14" }, end: { date: "2026-10-15" } } }, "all_day"],
    ["recurring master", { event: { ...event, recurrence: ["RRULE:FREQ=WEEKLY"] } }, "recurring_master"],
    ["cancelled", { event: { ...event, status: "cancelled" } }, "event_cancelled"],
    [
      "subject declined",
      {
        event: {
          ...event,
          attendees: [event.attendees![0], { email: "yossi@acme.co.il", responseStatus: "declined" }],
        },
      },
      "declined",
    ],
    ["skip title", { rules: { ...rules, skipTitlePatterns: ["שבועי"] } }, "title_skipped"],
    ["skip title case-insensitive", { event: { ...event, summary: "1:1 PRIVATE" }, rules: { ...rules, skipTitlePatterns: ["private"] } }, "title_skipped"],
    ["platform disabled", { config: { ...config, platforms: ["zoom" as const] } }, "platform_disabled"],
    ["too few attendees", { rules: { ...rules, minAttendees: 3 } }, "too_few_attendees"],
  ] as const)("skips %s", (_label, overrides, reason) => {
    expect(evaluateAutoJoin(input(overrides as Partial<AutoJoinInput>))).toEqual({ join: false, reason })
  })

  it("does not count declined attendees, resources or the bot account", () => {
    const crowded: CalendarEventLike = {
      ...event,
      attendees: [
        { email: "dana@acme.co.il", responseStatus: "accepted" },
        { email: "x@acme.co.il", responseStatus: "declined" },
        { email: "room@resource.calendar.google.com", resource: true },
        { email: "notetaker@acme.co.il", responseStatus: "accepted" },
      ],
    }

    expect(evaluateAutoJoin(input({ event: crowded }))).toEqual({ join: false, reason: "too_few_attendees" })
  })

  describe("window", () => {
    it("joins late within MEETSUM_BOT_LATE_JOIN_MAX_MINUTES", () => {
      const now = new Date("2026-10-14T09:29:00.000Z")

      expect(evaluateAutoJoin(input({ now }))).toEqual({ join: true, dispatchAt: now })
    })

    it("skips starts more than the late-join max in the past", () => {
      expect(evaluateAutoJoin(input({ now: new Date("2026-10-14T09:31:00.000Z") }))).toEqual({
        join: false,
        reason: "missed_window",
      })
    })

    it("skips events that already ended", () => {
      const short = { ...event, end: { dateTime: "2026-10-14T09:10:00.000Z" } }

      expect(evaluateAutoJoin(input({ event: short, now: new Date("2026-10-14T09:11:00.000Z") }))).toEqual({
        join: false,
        reason: "missed_window",
      })
    })
  })

  describe("external_only", () => {
    const external = { ...rules, autoJoin: "external_only" as const }

    it("skips meetings with only internal attendees", () => {
      expect(evaluateAutoJoin(input({ rules: external }))).toEqual({ join: false, reason: "not_external" })
    })

    it("joins when a non-declined attendee is external", () => {
      const withGuest = {
        ...event,
        attendees: [...event.attendees!, { email: "guest@client.example", responseStatus: "tentative" }],
      }

      expect(evaluateAutoJoin(input({ rules: external, event: withGuest })).join).toBe(true)
    })

    it("ignores declined externals and treats configured domains as internal", () => {
      const declinedGuest = {
        ...event,
        attendees: [
          ...event.attendees!,
          { email: "guest@client.example", responseStatus: "declined" },
          { email: "eng@acme-labs.com", responseStatus: "accepted" },
        ],
      }

      expect(evaluateAutoJoin(input({ rules: external, event: declinedGuest }))).toEqual({
        join: false,
        reason: "not_external",
      })

      const ruleDomain = {
        ...event,
        attendees: [...event.attendees!, { email: "pm@partner.example", responseStatus: "accepted" }],
      }

      expect(
        evaluateAutoJoin(input({ rules: { ...external, internalDomains: ["partner.example"] }, event: ruleDomain }))
      ).toEqual({ join: false, reason: "not_external" })
    })
  })

  describe("owner_only", () => {
    const owner = { ...rules, autoJoin: "owner_only" as const }

    it("joins when the organizer is a member", () => {
      expect(evaluateAutoJoin(input({ rules: owner })).join).toBe(true)
    })

    it("skips events organized by outsiders", () => {
      expect(
        evaluateAutoJoin(input({ rules: owner, event: { ...event, organizer: { email: "boss@client.example" } } }))
      ).toEqual({ join: false, reason: "not_owner" })
    })
  })
})

describe("helpers", () => {
  it("resolveInternalDomains merges member, env and rule domains", () => {
    expect(resolveInternalDomains(["a@x.com", "b@X.com"], { internalDomains: ["y.com"] }, { internalDomains: ["@Z.com"] })).toEqual([
      "x.com",
      "y.com",
      "z.com",
    ])
  })

  it("resolveBotLanguage", () => {
    expect(resolveBotLanguage("meeting", "he-IL")).toBe("he")
    expect(resolveBotLanguage("meeting", "en")).toBe("en")
    expect(resolveBotLanguage("meeting", "mixed")).toBeUndefined()
    expect(resolveBotLanguage("auto", "he")).toBeUndefined()
    expect(resolveBotLanguage("en", "he")).toBe("en")
  })

  it("ensureRecordingBotName always signals recording", () => {
    expect(ensureRecordingBotName("MeetSum Notetaker")).toBe("MeetSum Notetaker")
    expect(ensureRecordingBotName("Acme bot")).toBe("Acme bot · Recording")
    expect(ensureRecordingBotName("הבוט של אקמה", "he")).toBe("הבוט של אקמה · מקליט")
    expect(ensureRecordingBotName("x".repeat(80)).length).toBeLessThanOrEqual(60)
  })
})
