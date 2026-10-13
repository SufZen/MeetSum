import { describe, expect, it } from "vitest"

import type { MeetingParticipant, MeetingSpeaker } from "@/lib/meetings/repository"
import { isFirstPersonOwner, resolveOwner } from "@/lib/tasks/owner-resolution"
import type { TaskMember } from "@/lib/tasks/types"

const NOW = "2026-10-15T09:00:00.000Z"

function participant(id: string, name: string, email?: string): MeetingParticipant {
  return {
    id,
    meetingId: "meet_1",
    name,
    email,
    role: "attendee",
    source: "calendar",
    attendanceStatus: "accepted",
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function speaker(id: string, label: string, extra: Partial<MeetingSpeaker> = {}): MeetingSpeaker {
  return {
    id,
    meetingId: "meet_1",
    label,
    mappingStatus: "confirmed",
    source: "diarization",
    talkTimeMs: 1000,
    wordCount: 10,
    segmentCount: 1,
    ...extra,
  }
}

const participants = [
  participant("p_dana", "דנה כהן", "dana@example.com"),
  participant("p_yossi", "Yossi Levi", "yossi.levi@example.com"),
  participant("p_noa", "נועה", undefined),
]
const speakers = [
  speaker("spk_1", "Speaker 1", { participantId: "p_dana", displayName: "דנה כהן" }),
  speaker("spk_2", "Speaker 2", { participantId: "p_yossi", displayName: "Yossi Levi" }),
  speaker("spk_3", "Speaker 3"),
]
const members: TaskMember[] = [
  { userId: "user_dana", email: "Dana@Example.com", name: "Dana Cohen" },
  { userId: "user_ron", email: "ron@example.com", name: "רון" },
]
const base = { speakers, participants, members }

describe("resolveOwner", () => {
  it("resolves first person to the source speaker, its participant and member", () => {
    for (const ownerText of ["אני", "אני אשלח", "I'll", "I will send it", "me"]) {
      expect(resolveOwner({ ...base, ownerText, sourceSpeakerId: "spk_1" }), ownerText).toMatchObject({
        speakerId: "spk_1",
        participantId: "p_dana",
        userId: "user_dana",
        displayName: "דנה כהן",
        method: "source_speaker",
        confidence: 0.9,
      })
    }
  })

  it("uses the source speaker when the model says so, even without owner text", () => {
    expect(
      resolveOwner({ ...base, ownerIsSourceSpeaker: true, sourceSpeakerId: "spk_2" })
    ).toMatchObject({ speakerId: "spk_2", participantId: "p_yossi", method: "source_speaker" })
  })

  it("keeps a first-person owner unresolved when the speaker is unknown", () => {
    expect(resolveOwner({ ...base, ownerText: "אני" })).toMatchObject({
      ownerText: "אני",
      method: "none",
    })
  })

  it("matches the exact full name", () => {
    expect(resolveOwner({ ...base, ownerText: "דנה כהן" })).toMatchObject({
      participantId: "p_dana",
      speakerId: "spk_1",
      userId: "user_dana",
      method: "full_name",
      confidence: 0.95,
    })
    expect(resolveOwner({ ...base, ownerText: "yossi levi" })).toMatchObject({
      participantId: "p_yossi",
      method: "full_name",
    })
  })

  it("matches a unique first name and peels a Hebrew prefix", () => {
    expect(resolveOwner({ ...base, ownerText: "דנה" })).toMatchObject({
      participantId: "p_dana",
      method: "first_name",
    })
    expect(resolveOwner({ ...base, ownerText: "לדנה" })).toMatchObject({
      participantId: "p_dana",
      method: "first_name",
    })
    expect(resolveOwner({ ...base, ownerText: "וְנוֹעָה" })).toMatchObject({
      participantId: "p_noa",
      method: "full_name",
    })
  })

  it("keeps the text only when a first name is ambiguous", () => {
    const result = resolveOwner({
      ...base,
      participants: [...participants, participant("p_dana2", "דנה לוי", "dana.levi@example.com")],
      ownerText: "דנה",
    })

    expect(result).toEqual({ ownerText: "דנה", displayName: "דנה", confidence: 0, method: "none" })
  })

  it("matches Hebrew to Latin names only through aliases", () => {
    expect(resolveOwner({ ...base, ownerText: "יוסי" }).method).toBe("none")
    expect(
      resolveOwner({
        ...base,
        ownerText: "יוסי",
        profileAliases: [{ name: "Yossi Levi", email: "yossi.levi@example.com", aliases: ["יוסי", "יוסי לוי"] }],
      })
    ).toMatchObject({ participantId: "p_yossi", speakerId: "spk_2", method: "alias", confidence: 0.85 })
  })

  it("matches the email local part", () => {
    expect(resolveOwner({ ...base, ownerText: "ron" })).toMatchObject({
      userId: "user_ron",
      method: "email",
    })
    expect(resolveOwner({ ...base, ownerText: "yossi.levi@example.com" })).toMatchObject({
      participantId: "p_yossi",
      method: "email",
    })
  })

  it("fills the member by participant email", () => {
    expect(resolveOwner({ ...base, ownerText: "Dana Cohen" })).toMatchObject({
      participantId: "p_dana",
      userId: "user_dana",
    })
  })

  it("never treats a speaker label as a name", () => {
    expect(resolveOwner({ ...base, ownerText: "Speaker 3" }).method).toBe("none")
  })

  it("keeps unknown owners as text", () => {
    expect(resolveOwner({ ...base, ownerText: "  צוות הכספים " })).toEqual({
      ownerText: "צוות הכספים",
      displayName: "צוות הכספים",
      confidence: 0,
      method: "none",
    })
    expect(resolveOwner({ ...base })).toMatchObject({ ownerText: undefined, method: "none" })
  })
})

describe("isFirstPersonOwner", () => {
  it("detects Hebrew and English first person only at the start", () => {
    expect(isFirstPersonOwner("אני")).toBe(true)
    expect(isFirstPersonOwner("אנחנו נבדוק")).toBe(true)
    expect(isFirstPersonOwner("I’ll")).toBe(true)
    expect(isFirstPersonOwner("Ian")).toBe(false)
    expect(isFirstPersonOwner("דנה")).toBe(false)
  })
})
