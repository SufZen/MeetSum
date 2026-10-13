import { describe, expect, it } from "vitest"

import {
  directionForLanguage,
  genericSpeakerNumber,
  localizeSpeakerLabel,
  orderSpeakers,
  resolveSegmentSpeaker,
  sortReasons,
  speakerColors,
  speakerDisplay,
  speakerInitials,
  talkTimeShare,
} from "@/components/speaker-display"
import type { MeetingSpeaker } from "@/lib/meetings/repository"

const HE = "דובר {n}"

function speaker(overrides: Partial<MeetingSpeaker> & { id: string; label: string }): MeetingSpeaker {
  return {
    meetingId: "m",
    mappingStatus: "unmapped",
    source: "asr",
    talkTimeMs: 0,
    wordCount: 0,
    segmentCount: 0,
    ...overrides,
  }
}

const participants = [{ id: "p_dana", name: "דנה כהן" }]

describe("speaker display helpers", () => {
  it("localizes generic labels only", () => {
    expect(genericSpeakerNumber("Speaker 12")).toBe(12)
    expect(genericSpeakerNumber("Dana")).toBeUndefined()
    expect(localizeSpeakerLabel("Speaker 2", HE)).toBe("דובר 2")
    expect(localizeSpeakerLabel("Dana", HE)).toBe("Dana")
  })

  it("resolves participant → display name → label, flagging unconfirmed names", () => {
    expect(
      speakerDisplay(speaker({ id: "a", label: "Speaker 1", participantId: "p_dana", mappingStatus: "confirmed" }), participants, HE)
    ).toEqual({ name: "דנה כהן", unconfirmed: false, generic: false })
    expect(
      speakerDisplay(speaker({ id: "a", label: "Speaker 1", displayName: "Avi", mappingStatus: "suggested" }), participants, HE)
    ).toEqual({ name: "Avi", unconfirmed: true, generic: false })
    expect(speakerDisplay(speaker({ id: "a", label: "Speaker 3" }), participants, HE)).toEqual({
      name: "דובר 3",
      unconfirmed: false,
      generic: true,
    })
  })

  it("never shows a suggestion as the speaker name", () => {
    const suggested = speaker({
      id: "a",
      label: "Speaker 1",
      mappingStatus: "suggested",
      suggestion: { name: "דנה", score: 0.9, reasons: [], computedAt: "" },
    })

    expect(speakerDisplay(suggested, participants, HE).name).toBe("דובר 1")
  })

  it("orders and colours speakers by first speech", () => {
    const speakers = [
      speaker({ id: "b", label: "Speaker 2", firstStartMs: 5000 }),
      speaker({ id: "a", label: "Speaker 1", firstStartMs: 0 }),
      speaker({ id: "c", label: "Speaker 3" }),
    ]

    expect(orderSpeakers(speakers).map((item) => item.id)).toEqual(["a", "b", "c"])
    expect([...speakerColors(speakers).entries()]).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ])
  })

  it("builds initials and talk-time shares", () => {
    expect(speakerInitials({ name: "דובר 4", generic: true, unconfirmed: false }, "Speaker 4")).toBe("4")
    expect(speakerInitials({ name: "dana cohen levi", generic: false, unconfirmed: false }, "Speaker 1")).toBe("DC")
    expect(talkTimeShare(1, 3)).toBe("33%")
    expect(talkTimeShare(5, 0)).toBe("0%")
  })

  it("derives paragraph direction from a known language", () => {
    expect(directionForLanguage("he")).toBe("rtl")
    expect(directionForLanguage("he-IL")).toBe("rtl")
    expect(directionForLanguage("en")).toBe("ltr")
    expect(directionForLanguage("mixed")).toBeUndefined()
    expect(directionForLanguage(undefined)).toBeUndefined()
  })

  it("resolves segment speakers by id, then legacy label", () => {
    const speakers = [speaker({ id: "s1", label: "Speaker 1", participantId: "p_dana", mappingStatus: "confirmed", firstStartMs: 0 })]
    const colors = speakerColors(speakers)

    expect(
      resolveSegmentSpeaker({ speaker: "Speaker 1", speakerId: "s1" }, speakers, participants, colors, HE)
    ).toMatchObject({ name: "דנה כהן", speakerId: "s1", color: 1, initials: "דכ" })
    expect(resolveSegmentSpeaker({ speaker: "Speaker 2" }, [], participants, colors, HE)).toMatchObject({
      name: "דובר 2",
      generic: true,
      color: 2,
    })
    expect(resolveSegmentSpeaker({ speaker: "Ruth" }, [], participants, colors, HE)).toMatchObject({
      name: "Ruth",
      generic: false,
      unconfirmed: false,
    })
  })

  it("sorts suggestion reasons by weight", () => {
    expect(
      sortReasons([
        { kind: "addressed_by_name", detail: "", weight: 0.15 },
        { kind: "meet_alignment", detail: "", weight: 0.9 },
      ]).map((reason) => reason.kind)
    ).toEqual(["meet_alignment", "addressed_by_name"])
  })
})
