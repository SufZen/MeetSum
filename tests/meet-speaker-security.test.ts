import { describe, expect, it, vi } from "vitest"

import {
  buildMeetSpeakerIdentities,
  convertMeetTranscriptEntriesToSegments,
  listMeetParticipants,
} from "@/lib/google/meet-artifacts"
import { createInMemoryMeetingRepository } from "@/lib/meetings/repository"
import {
  MEET_NAME_ONLY_WEIGHT,
  planMeetSpeakerMappings,
} from "@/lib/meetings/speakers/meet-import"
import { sanitizeDisplayName } from "@/lib/meetings/speakers/names"
import { refreshSpeakerSuggestions } from "@/lib/meetings/speakers/suggest"
import type { MeetSpeakerIdentity } from "@/lib/meetings/speakers/types"

/**
 * Meet display names are attacker-controlled (anonymous/phone guests pick
 * their own; signed-in names are arbitrary). A name alone must never confirm
 * a speaker as a participant, and automatic import must never write
 * workspace speaker profiles.
 */

const ENV = {} as NodeJS.ProcessEnv
const NOW = new Date("2026-10-13T10:00:00.000Z")

async function seedMeetImport(labels: string[]) {
  const repository = createInMemoryMeetingRepository()
  const meeting = await repository.createMeeting({
    title: "Board sync",
    source: "google_meet",
    language: "en",
    startedAt: "2026-10-01T09:00:00.000Z",
    participants: ["dana@example.com", "ceo@example.com"],
  })
  const segments = labels.map((label, index) => ({
    id: `e${index}`,
    speaker: label,
    startMs: index * 5_000,
    endMs: index * 5_000 + 4_000,
    text: "hello",
    source: "meet",
  }))

  await repository.replaceTranscript(meeting.id, {
    segments,
    speakers: labels.map((label, index) => ({
      label,
      source: "meet",
      talkTimeMs: 4_000,
      wordCount: 1,
      segmentCount: 1,
      firstStartMs: index * 5_000,
    })),
  })

  return { repository, meeting }
}

describe("Meet import never confirms on a display name alone", () => {
  it("only suggests an anonymous 'dana' matching attendee dana", async () => {
    const { repository, meeting } = await seedMeetImport(["dana"])
    const identities: MeetSpeakerIdentity[] = [
      // A forged email on an anonymous identity must be ignored.
      { label: "dana", kind: "anonymous", verifiedEmail: "dana@example.com" },
    ]

    await refreshSpeakerSuggestions(repository, meeting.id, {
      env: ENV,
      now: NOW,
      meetIdentities: identities,
    })

    const [speaker] = await repository.listMeetingSpeakers(meeting.id)

    expect(speaker.mappingStatus).toBe("suggested")
    expect(speaker.participantId).toBeUndefined()
    expect(speaker.suggestion).toMatchObject({
      name: "dana",
      score: MEET_NAME_ONLY_WEIGHT,
      reasons: [{ kind: "meet_alignment", weight: MEET_NAME_ONLY_WEIGHT }],
    })
    expect(speaker.suggestion?.participantId).toBeTruthy()
  })

  it("only suggests without identities, for phone users and for unresolved signed-in users", async () => {
    const { repository, meeting } = await seedMeetImport(["dana"])
    const speakers = await repository.listMeetingSpeakers(meeting.id)
    const participants = await repository.listMeetingParticipants(meeting.id)

    for (const identities of [
      undefined,
      [{ label: "dana", kind: "phone" as const }],
      [{ label: "dana", kind: "signedin" as const, userId: "users/1" }],
      // Email without a Google user id is not a verified identity.
      [{ label: "dana", kind: "signedin" as const, verifiedEmail: "dana@example.com" }],
    ]) {
      const [plan] = planMeetSpeakerMappings(speakers, participants, { identities, now: NOW })

      expect(plan.mappingStatus, JSON.stringify(identities)).toBe("suggested")
      expect(plan.participantId).toBeUndefined()
    }
  })

  it("confirms a signed-in user whose verified email equals the participant's email", async () => {
    const { repository, meeting } = await seedMeetImport(["Dana Cohen", "CEO"])
    const dana = (await repository.listMeetingParticipants(meeting.id)).find(
      (participant) => participant.email === "dana@example.com"
    )!

    await refreshSpeakerSuggestions(repository, meeting.id, {
      env: ENV,
      now: NOW,
      meetIdentities: [
        {
          label: "Dana Cohen",
          kind: "signedin",
          userId: "users/111",
          verifiedEmail: "Dana@Example.com",
        },
        // Signed in as "CEO" with someone else's verified email → no match.
        { label: "CEO", kind: "signedin", userId: "users/999", verifiedEmail: "intruder@evil.test" },
      ],
    })

    const speakers = await repository.listMeetingSpeakers(meeting.id)

    expect(speakers.find((speaker) => speaker.label === "Dana Cohen")).toMatchObject({
      mappingStatus: "confirmed",
      participantId: dana.id,
      displayName: "dana",
    })
    expect(speakers.find((speaker) => speaker.label === "CEO")).toMatchObject({
      mappingStatus: "suggested",
    })
    expect(speakers.find((speaker) => speaker.label === "CEO")?.participantId).toBeUndefined()
  })

  it("never writes speaker profiles from automatic import or suggestions", async () => {
    const { repository, meeting } = await seedMeetImport(["dana", "Dana Cohen"])
    const recordConfirmed = vi.spyOn(repository, "recordConfirmedSpeaker")

    await refreshSpeakerSuggestions(repository, meeting.id, {
      env: ENV,
      now: NOW,
      meetIdentities: [
        { label: "Dana Cohen", kind: "signedin", userId: "users/1", verifiedEmail: "dana@example.com" },
      ],
      meetTimeline: [{ name: "dana", startMs: 0, endMs: 60_000 }],
    })

    expect(recordConfirmed).not.toHaveBeenCalled()
    expect(await repository.listSpeakerProfiles()).toEqual([])
  })

  it("never auto-confirms from Meet timeline names, even with auto-confirm enabled", async () => {
    const repository = createInMemoryMeetingRepository()
    const meeting = await repository.createMeeting({
      title: "Diarized",
      source: "upload",
      language: "en",
      startedAt: "2026-10-01T09:00:00.000Z",
      participants: ["Dana", "Ran", "Maya"],
    })

    await repository.replaceTranscript(meeting.id, {
      segments: [{ id: "s1", speaker: "Speaker 1", startMs: 0, endMs: 60_000, text: "..." }],
      speakers: [],
    })
    await refreshSpeakerSuggestions(repository, meeting.id, {
      env: { MEETSUM_SPEAKER_AUTO_CONFIRM_SCORE: "0.5" } as unknown as NodeJS.ProcessEnv,
      meetTimeline: [{ name: "Dana", startMs: 0, endMs: 60_000 }],
    })

    const [speaker] = await repository.listMeetingSpeakers(meeting.id)

    expect(speaker.mappingStatus).toBe("suggested")
    expect(speaker.suggestion?.name).toBe("Dana")
  })
})

describe("Meet display name sanitising", () => {
  it("strips bidi overrides/isolates and control characters, trims and caps at 80", () => {
    expect(sanitizeDisplayName("  ‮Dana‬⁦ CEO⁩\u0007\n ")).toBe("Dana CEO")
    expect(sanitizeDisplayName("‪‫‭")).toBeUndefined()
    expect([...sanitizeDisplayName("א".repeat(200))!]).toHaveLength(80)
  })

  it("sanitises names from the participants API and the stored labels", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          participants: [
            {
              name: "conferenceRecords/r/participants/evil",
              anonymousUser: { displayName: "‮CEO approved‬" },
            },
          ],
        })
      )) as unknown as typeof fetch
    const resolver = vi.fn(async () => "ceo@example.com")
    const participants = await listMeetParticipants("t", "conferenceRecords/r", fetchImpl, 10, resolver)

    expect(participants).toEqual([
      { name: "conferenceRecords/r/participants/evil", displayName: "CEO approved", kind: "anonymous" },
    ])
    // Anonymous participants are never resolved to an email.
    expect(resolver).not.toHaveBeenCalled()

    const segments = convertMeetTranscriptEntriesToSegments(
      [
        {
          name: "conferenceRecords/r/transcripts/t/entries/1",
          participant: "conferenceRecords/r/participants/evil",
          text: "ok",
          startTime: "2026-10-01T09:00:01Z",
          endTime: "2026-10-01T09:00:02Z",
        },
      ],
      {
        baseTime: "2026-10-01T09:00:00Z",
        participantNames: { "conferenceRecords/r/participants/evil": "‮CEO‬\u0000" },
      }
    )

    expect(segments[0].speaker).toBe("CEO")
  })

  it("verifies only signed-in users through the resolver; shared labels stay unverified", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          participants: [
            {
              name: "conferenceRecords/r/participants/a",
              signedinUser: { user: "users/1", displayName: "Dana" },
            },
            {
              name: "conferenceRecords/r/participants/b",
              signedinUser: { user: "users/2", displayName: "Ran" },
            },
            {
              name: "conferenceRecords/r/participants/c",
              anonymousUser: { displayName: "Ran" },
            },
          ],
        })
      )) as unknown as typeof fetch
    const resolver = vi.fn(async (userId: string) =>
      userId === "users/1" ? "DANA@example.com" : "ran@example.com"
    )
    const identities = buildMeetSpeakerIdentities(
      await listMeetParticipants("t", "conferenceRecords/r", fetchImpl, 10, resolver)
    )

    expect(resolver).toHaveBeenCalledTimes(2)
    expect(identities).toEqual([
      { label: "Dana", kind: "signedin", userId: "users/1", verifiedEmail: "dana@example.com" },
      // "Ran" is claimed by a signed-in user and an anonymous guest.
      { label: "Ran", kind: "unknown" },
    ])
  })

  it("stores sanitised names in suggestions", () => {
    const [plan] = planMeetSpeakerMappings(
      [
        {
          id: "sp_1",
          meetingId: "m",
          label: "‮CEO‬",
          mappingStatus: "unmapped",
          source: "meet",
          talkTimeMs: 1,
          wordCount: 1,
          segmentCount: 1,
        },
      ],
      [],
      { now: NOW }
    )

    expect(plan.suggestion?.name).toBe("CEO")
  })
})
