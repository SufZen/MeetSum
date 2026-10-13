import { describe, expect, it } from "vitest"

import { matchesRuleFilters, meetingFactsFromRecord } from "@/lib/integrations/core/rule-filters"
import type { MeetingFacts, RuleFilters } from "@/lib/integrations/core/types"
import type { MeetingRecord } from "@/lib/meetings/repository"

/** M8 "Rules" filters: a pure matrix, all AND-ed. */

const FACTS: MeetingFacts = {
  meetingId: "m1",
  workspaceId: "ws_a",
  visibility: "workspace",
  ownerUserId: "u1",
  contextIds: ["room_sales"],
  tagNames: ["Sales", "finance"],
  participantEmails: ["dana@acme.co.il", "client@customer.com"],
  language: "he-IL",
  source: "upload",
  durationMs: 30 * 60_000,
}
const CTX = { internalDomains: ["acme.co.il"] }

describe("matchesRuleFilters", () => {
  const cases: [string, RuleFilters, Partial<MeetingFacts>, boolean][] = [
    ["empty filters match a workspace meeting", {}, {}, true],
    ["empty filters skip private meetings by default", {}, { visibility: "private" }, false],
    ["unknown visibility counts as private", {}, { visibility: undefined }, false],
    ["link meetings pass the default", {}, { visibility: "link" }, true],
    ["visibility filter", { visibility: ["link"] }, {}, false],
    ["room match", { roomIds: ["room_sales", "x"] }, {}, true],
    ["room miss", { roomIds: ["room_ops"] }, {}, false],
    ["tag any match, case-insensitive", { tagNames: ["SALES"] }, {}, true],
    ["tag miss", { tagNames: ["legal"] }, {}, false],
    ["language base match", { languages: ["he"] }, {}, true],
    ["language miss", { languages: ["en"] }, {}, false],
    ["source match", { sources: ["upload"] }, {}, true],
    ["source miss", { sources: ["google_meet"] }, {}, false],
    ["min duration met", { minDurationMinutes: 30 }, {}, true],
    ["min duration not met", { minDurationMinutes: 31 }, {}, false],
    ["unknown duration fails a minimum", { minDurationMinutes: 1 }, { durationMs: undefined }, false],
    ["any_external with a customer", { participantDomains: { mode: "any_external", domains: [] } }, {}, true],
    [
      "any_external with internal only",
      { participantDomains: { mode: "any_external", domains: [] } },
      { participantEmails: ["dana@acme.co.il"] },
      false,
    ],
    ["includes", { participantDomains: { mode: "includes", domains: ["@customer.com"] } }, {}, true],
    ["includes miss", { participantDomains: { mode: "includes", domains: ["other.com"] } }, {}, false],
    ["excludes", { participantDomains: { mode: "excludes", domains: ["customer.com"] } }, {}, false],
    ["excludes pass", { participantDomains: { mode: "excludes", domains: ["other.com"] } }, {}, true],
    ["AND of several filters", { roomIds: ["room_sales"], languages: ["en"] }, {}, false],
  ]

  it.each(cases)("%s", (_name, filters, overrides, expected) => {
    expect(matchesRuleFilters(filters, { ...FACTS, ...overrides }, CTX)).toBe(expected)
  })

  it("lets an include_private rule evaluate private meetings when it sets no visibility", () => {
    expect(matchesRuleFilters({}, { ...FACTS, visibility: "private" }, { ...CTX, includePrivate: true })).toBe(true)
    expect(matchesRuleFilters({ visibility: ["workspace"] }, { ...FACTS, visibility: "private" }, { ...CTX, includePrivate: true })).toBe(false)
  })

  it("builds facts from a meeting record", () => {
    const meeting = {
      id: "m1",
      title: "t",
      source: "upload",
      language: "he",
      status: "completed",
      retention: "audio",
      startedAt: "2026-10-01T10:00:00.000Z",
      participants: [],
      participantDetails: [
        { id: "p1", meetingId: "m1", name: "Dana", email: "Dana@Acme.co.il", role: "attendee", source: "calendar", attendanceStatus: "accepted", createdAt: "" },
        { id: "p2", meetingId: "m1", name: "Avi", role: "speaker", source: "transcript", attendanceStatus: "unknown", createdAt: "" },
      ],
      contexts: [{ id: "room_sales", name: "Sales", createdAt: "" }],
      tags: ["sales"],
      ownerUserId: "u1",
      visibility: "private",
      durationMs: 1000,
    } as unknown as MeetingRecord

    expect(meetingFactsFromRecord(meeting, "ws_a")).toEqual({
      meetingId: "m1",
      workspaceId: "ws_a",
      visibility: "private",
      ownerUserId: "u1",
      contextIds: ["room_sales"],
      tagNames: ["sales"],
      participantEmails: ["dana@acme.co.il"],
      language: "he",
      source: "upload",
      durationMs: 1000,
    })
  })
})
