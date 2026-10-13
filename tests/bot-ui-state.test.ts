import { describe, expect, it } from "vitest"

import {
  BOT_REASON_MESSAGE,
  BOT_STEPS,
  botHintFor,
  botPillFor,
  botReasonMessageKey,
  botStepFor,
  botStripActions,
  changedBotMeetingIds,
  pickInboxPill,
  shouldShowBotStrip,
  STRIP_FAILURE_WINDOW_MS,
} from "@/components/bot/bot-ui-state"
import {
  addDomainChip,
  botNamePreview,
  buildBotRulesPatch,
  clampLead,
  draftFromRules,
  normalizeDomain,
  parseSkipPatterns,
  validateBotRulesDraft,
} from "@/components/bot/bot-rules-state"
import { liveSegmentDir, upsertLiveSegment } from "@/components/bot/live-transcript-state"
import {
  BOT_STATUSES,
  BOT_STATUS_REASONS,
  DEFAULT_BOT_RULES,
  type BotSessionSummary,
  type BotStatus,
} from "@/lib/bot/types"
import { botMessagesEn } from "@/lib/i18n/m7/bot"

function session(overrides: Partial<BotSessionSummary> = {}): BotSessionSummary {
  return {
    id: "bot_1",
    meetingId: "meet_1",
    status: "scheduled",
    statusReason: null,
    platform: "google_meet",
    scheduledStart: "2026-10-13T11:00:00.000Z",
    joinedAt: null,
    leftAt: null,
    consentStatus: "pending",
    recordingStatus: "none",
    botName: "MeetSum Notetaker",
    ...overrides,
  }
}

describe("botPillFor", () => {
  const expected: Record<BotStatus, ReturnType<typeof botPillFor>> = {
    scheduled: null,
    requested: { status: "processing", labelKey: "botPillJoining" },
    joining: { status: "processing", labelKey: "botPillJoining" },
    stopping: { status: "processing", labelKey: "botPillJoining" },
    awaiting_admission: { status: "review", labelKey: "botPillWaiting" },
    needs_help: { status: "review", labelKey: "botPillWaiting" },
    active: { status: "live", labelKey: "botPillRecording" },
    failed: { status: "failed", labelKey: "botReasonUnknown" },
    blocked: { status: "failed", labelKey: "botReasonUnknown" },
    completed: null,
    cancelled: null,
  }

  it.each(BOT_STATUSES)("maps %s", (status) => {
    expect(botPillFor(status)).toEqual(expected[status])
  })

  it("never offers a Ready pill and uses live only for an active recording", () => {
    const live = BOT_STATUSES.filter((status) => botPillFor(status)?.status === "live")

    expect(live).toEqual(["active"])
    expect(BOT_STATUSES.map((status) => botPillFor(status)?.labelKey)).not.toContain("botReady")
  })

  it.each(BOT_STATUS_REASONS)("labels failed/blocked with the localized %s reason", (reason) => {
    const key = BOT_REASON_MESSAGE[reason]

    expect(botMessagesEn[key]).toBeTruthy()
    expect(botPillFor("blocked", reason)).toEqual({ status: "failed", labelKey: key })
    expect(botPillFor("failed", reason)?.labelKey).toBe(key)
    expect(botReasonMessageKey(reason)).toBe(key)
  })

  it("shows the signed-out bot as such", () => {
    expect(botMessagesEn[botReasonMessageKey("bot_signed_out")]).toMatch(/^Bot signed out/)
  })
})

describe("pickInboxPill", () => {
  it("prefers live > review > failed > processing", () => {
    const p = (status: "live" | "review" | "failed" | "processing") => ({ status })

    expect(pickInboxPill(p("processing"), p("live"))).toEqual(p("live"))
    expect(pickInboxPill(p("failed"), p("review"))).toEqual(p("review"))
    expect(pickInboxPill(p("processing"), p("failed"))).toEqual(p("failed"))
    expect(pickInboxPill(null, p("processing"))).toEqual(p("processing"))
    expect(pickInboxPill(null, undefined)).toBeNull()
  })
})

describe("botStepFor", () => {
  it("follows the showcase steps", () => {
    expect(BOT_STEPS).toEqual(["scheduled", "joining", "waiting", "recording", "processing"])
    expect(botStepFor(session({ status: "scheduled" }))).toMatchObject({ current: 0, tone: "info" })
    expect(botStepFor(session({ status: "requested" }))).toMatchObject({ current: 1, tone: "info" })
    expect(botStepFor(session({ status: "joining" }))).toMatchObject({ current: 1 })
    expect(botStepFor(session({ status: "awaiting_admission" }))).toMatchObject({
      current: 2,
      tone: "warn",
      labelKey: "botStepWaiting",
    })
    expect(botStepFor(session({ status: "needs_help" }))).toMatchObject({ current: 2, tone: "warn" })
    expect(botStepFor(session({ status: "active" }))).toMatchObject({ current: 3, tone: "live" })
    expect(botStepFor(session({ status: "stopping" }))).toMatchObject({
      current: 3,
      labelKey: "botStepStopping",
    })
    expect(botStepFor(session({ status: "completed" }))).toMatchObject({
      current: 4,
      labelKey: "botStepProcessing",
    })
    expect(botStepFor(session({ status: "cancelled" }))).toBeNull()
  })

  it("stops a blocked or failed bot on the step where it went wrong", () => {
    expect(
      botStepFor(session({ status: "blocked", statusReason: "not_admitted" }))
    ).toEqual({ current: 2, tone: "danger", labelKey: "botStepBlocked" })
    expect(
      botStepFor(session({ status: "blocked", statusReason: "removed_by_host", joinedAt: "x" }))
    ).toMatchObject({ current: 3 })
    expect(
      botStepFor(session({ status: "failed", statusReason: "invalid_meeting_link" }))
    ).toEqual({ current: 1, tone: "danger", labelKey: "botStepFailed" })
  })
})

describe("strip visibility, hints and actions", () => {
  const now = Date.parse("2026-10-13T12:00:00.000Z")

  it("shows open sessions and failures from the last 24 hours only", () => {
    expect(shouldShowBotStrip(undefined, now)).toBe(false)
    expect(shouldShowBotStrip(session({ status: "scheduled" }), now)).toBe(true)
    expect(shouldShowBotStrip(session({ status: "active" }), now)).toBe(true)
    expect(shouldShowBotStrip(session({ status: "completed" }), now)).toBe(false)
    expect(shouldShowBotStrip(session({ status: "cancelled" }), now)).toBe(false)
    expect(
      shouldShowBotStrip(session({ status: "blocked", leftAt: "2026-10-13T08:00:00.000Z" }), now)
    ).toBe(true)
    expect(
      shouldShowBotStrip(
        session({
          status: "failed",
          leftAt: new Date(now - STRIP_FAILURE_WINDOW_MS - 1000).toISOString(),
        }),
        now
      )
    ).toBe(false)
  })

  it("asks the host to admit the bot by name while waiting", () => {
    expect(botHintFor(session({ status: "awaiting_admission" }))).toEqual({
      key: "botHintAdmit",
      params: { name: "MeetSum Notetaker" },
      tone: "warn",
    })
    expect(botMessagesEn.botHintAdmit).toBe("Ask the host to admit {name} from the waiting room")
  })

  it("tells the host to announce the recording when the chat notice is unsupported", () => {
    expect(botHintFor(session({ status: "active", consentStatus: "unsupported" }))?.key).toBe(
      "botHintAnnounce"
    )
    expect(botHintFor(session({ status: "active", consentStatus: "sent" }))?.key).toBe(
      "botHintRecording"
    )
    expect(botHintFor(session({ status: "blocked", statusReason: "bot_signed_out" }))).toEqual({
      key: "botReasonBotSignedOut",
      tone: "danger",
    })
    expect(botHintFor(session({ status: "joining", platform: "teams" }))?.params?.platform).toBe(
      "botPlatformTeams"
    )
  })

  it("offers only secondary actions that fit the state", () => {
    const opts = { canSend: true, canWrite: true, visible: true }

    expect(botStripActions(session({ status: "scheduled" }), opts)).toEqual(["dont_send"])
    expect(botStripActions(session({ status: "active" }), opts)).toEqual(["stop"])
    expect(botStripActions(session({ status: "awaiting_admission" }), opts)).toEqual(["stop"])
    expect(botStripActions(session({ status: "stopping" }), opts)).toEqual(["send"])
    expect(botStripActions(session({ status: "blocked" }), opts)).toEqual([
      "send",
      "record_browser",
      "import_desktop",
    ])
    expect(
      botStripActions(session({ status: "blocked" }), { ...opts, canSend: false })
    ).toEqual(["record_browser", "import_desktop"])
    expect(botStripActions(undefined, opts)).toEqual(["send"])
    expect(botStripActions(session({ status: "active" }), { ...opts, canWrite: false })).toEqual([])
    expect(botStripActions(undefined, { ...opts, canSend: false })).toEqual([])
  })

  it("lists meetings whose bot status changed between polls", () => {
    expect(
      changedBotMeetingIds(
        { a: { id: "1", status: "joining" }, b: { id: "2", status: "active" } },
        { a: { id: "1", status: "active" }, b: { id: "2", status: "active" }, c: { id: "3", status: "scheduled" } }
      )
    ).toEqual(["a", "c"])
  })
})

describe("bot rules settings state", () => {
  it("keeps auto-join behind the consent acknowledgment", () => {
    const draft = { ...draftFromRules({ ...DEFAULT_BOT_RULES }), autoJoin: "external_only" as const }

    expect(validateBotRulesDraft(draft, false).autoJoin).toBe("botConsentAckRequired")
    expect(validateBotRulesDraft(draft, true)).toEqual({})
  })

  it("rejects empty names and URLs in consent messages", () => {
    const draft = draftFromRules({ ...DEFAULT_BOT_RULES })

    expect(validateBotRulesDraft({ ...draft, botName: " " }, false).botName).toBe("botFieldInvalid")
    expect(
      validateBotRulesDraft(
        { ...draft, consentMessage: { he: "ראו https://evil.example", en: "ok" } },
        false
      ).consentHe
    ).toBe("botFieldInvalid")
  })

  it("previews the recording suffix once", () => {
    expect(botNamePreview("MeetSum Notetaker", "מקליט")).toBe("MeetSum Notetaker · מקליט")
    expect(botNamePreview("Recording bot", "Recording")).toBe("Recording bot")
  })

  it("normalizes domain chips and skip patterns", () => {
    expect(normalizeDomain("Dana@Realization.co.il")).toBe("realization.co.il")
    expect(normalizeDomain("https://acme.com/x")).toBe("acme.com")
    expect(normalizeDomain("not a domain")).toBeUndefined()
    expect(addDomainChip(["acme.com"], "ACME.com")).toEqual(["acme.com"])
    expect(parseSkipPatterns("1:1\n\n  פרטי \n1:1")).toEqual(["1:1", "פרטי"])
    expect(clampLead(9999)).toBe(600)
    expect(clampLead(-5)).toBe(0)
  })

  it("sends only changed fields plus a fresh acknowledgment", () => {
    const saved = { ...DEFAULT_BOT_RULES }
    const draft = { ...draftFromRules(saved), joinLeadSeconds: 120 }

    expect(buildBotRulesPatch(saved, draft, true)).toEqual({
      joinLeadSeconds: 120,
      acknowledgeConsent: true,
    })
    expect(
      buildBotRulesPatch({ ...saved, consentAcknowledgedAt: "2026-10-01T00:00:00Z" }, draft, true)
    ).toEqual({ joinLeadSeconds: 120 })
  })
})

describe("live transcript draft", () => {
  const seg = (id: string, startMs: number, text: string, final = false) => ({
    id,
    speaker: "Dana",
    text,
    startMs,
    endMs: startMs + 1000,
    language: "he",
    final,
  })

  it("upserts by segment id in time order", () => {
    let list = upsertLiveSegment([], seg("b", 2000, "שני"))

    list = upsertLiveSegment(list, seg("a", 1000, "ראשון"))
    list = upsertLiveSegment(list, seg("b", 2000, "שני סופי", true))

    expect(list.map((item) => [item.id, item.text, item.final])).toEqual([
      ["a", "ראשון", false],
      ["b", "שני סופי", true],
    ])
  })

  it("takes dir from the segment language, then the meeting language", () => {
    expect(liveSegmentDir("he", "en")).toBe("rtl")
    expect(liveSegmentDir("en-US", "he")).toBe("ltr")
    expect(liveSegmentDir(null, "he")).toBe("rtl")
    expect(liveSegmentDir(null, "mixed")).toBe("auto")
  })
})
