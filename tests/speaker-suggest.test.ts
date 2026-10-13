import { describe, expect, it } from "vitest"

import {
  createInMemoryMeetingRepository,
  type MeetingParticipant,
  type MeetingSpeaker,
  type SpeakerProfile,
  type TranscriptSegment,
} from "@/lib/meetings/repository"
import { normalizeName } from "@/lib/meetings/speakers/names"
import { extractSelfIntroductions } from "@/lib/meetings/speakers/signals/self-intro"
import {
  refreshSpeakerSuggestions,
  suggestSpeakerMappings,
  type SuggestSpeakerMappingsInput,
} from "@/lib/meetings/speakers/suggest"

const NOW = new Date("2026-10-13T10:00:00.000Z")

function participant(id: string, name: string, extra: Partial<MeetingParticipant> = {}): MeetingParticipant {
  return {
    id,
    meetingId: "meet_1",
    name,
    role: "attendee",
    source: "calendar",
    attendanceStatus: "accepted",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...extra,
  }
}

function speaker(id: string, label: string, extra: Partial<MeetingSpeaker> = {}): MeetingSpeaker {
  return {
    id,
    meetingId: "meet_1",
    label,
    mappingStatus: "unmapped",
    source: "asr",
    talkTimeMs: 60_000,
    wordCount: 100,
    segmentCount: 5,
    ...extra,
  }
}

function seg(speakerId: string, startMs: number, endMs: number, text: string): TranscriptSegment {
  return { id: `seg_${speakerId}_${startMs}`, speaker: speakerId, speakerId, startMs, endMs, text }
}

function input(overrides: Partial<SuggestSpeakerMappingsInput>): SuggestSpeakerMappingsInput {
  return {
    speakers: [speaker("sp_1", "Speaker 1"), speaker("sp_2", "Speaker 2")],
    segments: [],
    participants: [],
    profiles: [],
    now: NOW,
    ...overrides,
  }
}

function suggestionFor(results: ReturnType<typeof suggestSpeakerMappings>, speakerId: string) {
  return results.find((result) => result.speakerId === speakerId)
}

describe("name normalization", () => {
  it("is niqqud-, geresh- and case-insensitive", () => {
    expect(normalizeName("דָּנָה")).toBe("דנה")
    expect(normalizeName("ג׳ורג'")).toBe("גורג")
    expect(normalizeName("  Dana   COHEN, ")).toBe("dana cohen")
  })

  it("extracts Hebrew and English self-introductions", () => {
    expect(extractSelfIntroductions("שלום, אני דנה מהשיווק")).toEqual(["דנה מהשיווק"])
    expect(extractSelfIntroductions("שָׁלוֹם, אֲנִי דָּנָה")).toEqual(["דנה"])
    expect(extractSelfIntroductions("קוראים לי רן לוי ואני אחראי")).toEqual(["רן לוי"])
    expect(extractSelfIntroductions("Hi all, I'm Ran and this is fine")).toEqual(["Ran"])
    expect(extractSelfIntroductions("i am sure")).toEqual([])
  })
})

describe("self_intro", () => {
  it("suggests the participant a Hebrew speaker introduces themselves as", () => {
    const results = suggestSpeakerMappings(
      input({
        participants: [participant("p_dana", "דנה כהן"), participant("p_ran", "רן לוי"), participant("p_maya", "מאיה")],
        segments: [
          seg("sp_1", 1_000, 4_000, "שלום, אני דנה מהשיווק"),
          seg("sp_2", 5_000, 8_000, "בוקר טוב"),
        ],
      })
    )

    expect(suggestionFor(results, "sp_1")).toMatchObject({
      mappingStatus: "suggested",
      suggestion: {
        participantId: "p_dana",
        name: "דנה כהן",
        score: 0.75,
        computedAt: NOW.toISOString(),
        reasons: [{ kind: "self_intro", weight: 0.75 }],
      },
    })
    expect(suggestionFor(results, "sp_2")).toBeUndefined()
  })

  it("matches through niqqud", () => {
    const results = suggestSpeakerMappings(
      input({
        participants: [participant("p_dana", "דנה לוי"), participant("p_x", "אבי"), participant("p_y", "יוסי")],
        segments: [seg("sp_1", 0, 3_000, "שָׁלוֹם, אֲנִי דָּנָה")],
      })
    )

    expect(suggestionFor(results, "sp_1")?.suggestion.participantId).toBe("p_dana")
  })

  it("never transliterates Hebrew ↔ Latin; an alias from workspace memory bridges it", () => {
    const participants = [
      participant("p_dana", "Dana Cohen", { email: "dana@example.com" }),
      participant("p_ran", "Ran Levi"),
      participant("p_maya", "Maya"),
    ]
    const segments = [seg("sp_1", 0, 3_000, "שלום, אני דנה מהשיווק")]

    expect(suggestSpeakerMappings(input({ participants, segments }))).toEqual([])

    const profiles: SpeakerProfile[] = [
      {
        id: "prof_dana",
        workspaceId: "ws_1",
        displayName: "Dana Cohen",
        email: "dana@example.com",
        aliases: ["דנה"],
        confirmedCount: 3,
      },
    ]
    const [result] = suggestSpeakerMappings(input({ participants, profiles, segments }))

    expect(result.suggestion).toMatchObject({
      participantId: "p_dana",
      profileId: "prof_dana",
      email: "dana@example.com",
    })
    expect(result.suggestion.reasons.map((reason) => reason.kind)).toEqual([
      "self_intro",
      "workspace_memory",
    ])
    expect(result.suggestion.score).toBeCloseTo(1 - 0.25 * 0.9, 3)
  })

  it("suggests a workspace profile that is not on the invite (memory)", () => {
    const [result] = suggestSpeakerMappings(
      input({
        participants: [participant("p_a", "אבי"), participant("p_b", "בני"), participant("p_c", "גלית")],
        profiles: [
          { id: "prof_noa", workspaceId: "ws_1", displayName: "Noa Bar", aliases: ["נועה"], confirmedCount: 2 },
        ],
        segments: [seg("sp_1", 0, 3_000, "היי, שמי נועה")],
      })
    )

    expect(result.suggestion).toMatchObject({ profileId: "prof_noa", name: "Noa Bar" })
    expect(result.suggestion.participantId).toBeUndefined()
  })

  it("handles English introductions and ignores intros after 180 s or unknown names", () => {
    const participants = [participant("p_ran", "Ran Levi"), participant("p_a", "Avi"), participant("p_b", "Ben")]

    expect(
      suggestSpeakerMappings(input({ participants, segments: [seg("sp_1", 0, 2_000, "Hi, I'm Ran.")] }))[0]
        ?.suggestion.participantId
    ).toBe("p_ran")
    expect(
      suggestSpeakerMappings(
        input({ participants, segments: [seg("sp_1", 181_000, 183_000, "Hi, I'm Ran.")] })
      )
    ).toEqual([])
    expect(
      suggestSpeakerMappings(
        input({ participants, segments: [seg("sp_1", 0, 2_000, "אני חושב שזה בסדר")] })
      )
    ).toEqual([])
  })

  it("skips ambiguous first names", () => {
    expect(
      suggestSpeakerMappings(
        input({
          participants: [participant("p_1", "דנה כהן"), participant("p_2", "דנה לוי"), participant("p_3", "רן")],
          segments: [seg("sp_1", 0, 2_000, "אני דנה")],
        })
      )
    ).toEqual([])
  })
})

describe("meet_alignment", () => {
  const participants = [participant("p_dana", "Dana Cohen"), participant("p_ran", "Ran Levi"), participant("p_x", "X")]
  const segments = [
    seg("sp_1", 0, 30_000, "..."),
    seg("sp_2", 30_000, 40_000, "..."),
    seg("sp_1", 40_000, 70_000, "..."),
  ]

  it("suggests the Meet participant a speaker is ≥90% aligned with", () => {
    const results = suggestSpeakerMappings(
      input({
        participants,
        segments,
        meetTimeline: [
          { name: "Dana Cohen", startMs: 500, endMs: 29_000 },
          { name: "Ran Levi", startMs: 30_000, endMs: 40_000 },
          { name: "Dana Cohen", startMs: 40_000, endMs: 70_000 },
        ],
      })
    )
    const dana = suggestionFor(results, "sp_1")!

    expect(dana.suggestion.participantId).toBe("p_dana")
    expect(dana.suggestion.reasons[0]).toMatchObject({ kind: "meet_alignment" })
    expect(dana.suggestion.reasons[0].weight).toBeGreaterThan(0.95)
    // Only 10 s of overlap for Ran (< 20 s) → no alignment, and two
    // participants (Ran, X) are still free → no single_remaining.
    expect(suggestionFor(results, "sp_2")).toBeUndefined()
  })

  it("adds Meet names that are not participants as candidates", () => {
    const [result] = suggestSpeakerMappings(
      input({
        participants: [],
        segments,
        meetTimeline: [{ name: "Guest Speaker", startMs: 0, endMs: 70_000 }],
      })
    )

    expect(result).toMatchObject({ speakerId: "sp_1", suggestion: { name: "Guest Speaker" } })
  })

  it("is ignored when the Meet timeline is disabled", () => {
    expect(
      suggestSpeakerMappings(
        input({
          participants,
          segments,
          meetTimeline: [{ name: "Dana Cohen", startMs: 0, endMs: 70_000 }],
          options: { useMeetTimeline: false },
        })
      )
    ).toEqual([])
  })
})

describe("assignment", () => {
  it("assigns greedily one-to-one: the strongest claim wins the candidate", () => {
    const results = suggestSpeakerMappings(
      input({
        participants: [participant("p_dana", "דנה כהן"), participant("p_a", "אבי"), participant("p_b", "בני")],
        segments: [
          seg("sp_1", 0, 30_000, "אני דנה"),
          seg("sp_2", 30_000, 60_000, "אני דנה"),
        ],
        meetTimeline: [{ name: "דנה כהן", startMs: 30_000, endMs: 60_000 }],
      })
    )

    expect(suggestionFor(results, "sp_2")?.suggestion.participantId).toBe("p_dana")
    expect(suggestionFor(results, "sp_1")).toBeUndefined()
  })

  it("excludes rejected pairs and never touches confirmed or rejected speakers", () => {
    const participants = [participant("p_dana", "דנה"), participant("p_ran", "רן"), participant("p_x", "איקס")]
    const segments = [seg("sp_1", 0, 3_000, "אני דנה"), seg("sp_2", 3_000, 6_000, "אני רן")]

    const rejectedPair = suggestSpeakerMappings(
      input({
        participants,
        segments,
        rejectedPairs: [{ speakerId: "sp_1", candidateId: "p_dana" }],
      })
    )

    expect(suggestionFor(rejectedPair, "sp_1")).toBeUndefined()
    expect(suggestionFor(rejectedPair, "sp_2")?.suggestion.participantId).toBe("p_ran")

    const locked = suggestSpeakerMappings(
      input({
        speakers: [
          speaker("sp_1", "Speaker 1", { mappingStatus: "confirmed", participantId: "p_ran" }),
          speaker("sp_2", "Speaker 2", { mappingStatus: "rejected" }),
          speaker("sp_3", "Speaker 3"),
        ],
        participants,
        segments: [...segments, seg("sp_3", 6_000, 9_000, "אני רן")],
      })
    )

    // sp_3 claims Ran, but Ran belongs to the confirmed sp_1.
    expect(locked).toEqual([])
  })

  it("fills the last unmapped speaker with the single remaining participant", () => {
    const results = suggestSpeakerMappings(
      input({
        participants: [participant("p_dana", "דנה"), participant("p_ran", "רן")],
        segments: [seg("sp_1", 0, 3_000, "שלום, אני דנה מהשיווק"), seg("sp_2", 3_000, 6_000, "היי")],
      })
    )

    expect(suggestionFor(results, "sp_2")).toMatchObject({
      suggestion: {
        participantId: "p_ran",
        score: 0.55,
        reasons: [{ kind: "single_remaining", weight: 0.55 }],
      },
    })
  })

  it("auto-confirms only at or above the configured score", () => {
    const base = input({
      participants: [participant("p_dana", "דנה"), participant("p_a", "א"), participant("p_b", "ב")],
      segments: [seg("sp_1", 0, 3_000, "אני דנה")],
    })

    expect(suggestSpeakerMappings(base)[0].mappingStatus).toBe("suggested")
    expect(
      suggestSpeakerMappings({ ...base, options: { autoConfirmScore: 0.7 } })[0].mappingStatus
    ).toBe("confirmed")
  })
})

describe("addressed_by_name, organizer_owner, voiceprint", () => {
  it("counts replies after being addressed by name (+0.15 each, capped at 0.45)", () => {
    const participants = [participant("p_ran", "רן לוי"), participant("p_a", "אבי"), participant("p_b", "בני")]
    const segments: TranscriptSegment[] = []

    for (let turn = 0; turn < 4; turn += 1) {
      segments.push(seg("sp_1", turn * 10_000, turn * 10_000 + 3_000, "רן, מה דעתך?"))
      segments.push(seg("sp_2", turn * 10_000 + 4_000, turn * 10_000 + 8_000, "נראה לי טוב"))
    }

    // 0.45 alone stays below the 0.5 threshold.
    expect(suggestSpeakerMappings(input({ participants, segments }))).toEqual([])

    const [result] = suggestSpeakerMappings(
      input({ participants, segments, options: { threshold: 0.4 } })
    )

    expect(result).toMatchObject({
      speakerId: "sp_2",
      suggestion: { participantId: "p_ran", reasons: [{ kind: "addressed_by_name", weight: 0.45 }] },
    })
  })

  it("boosts the top talker toward the organizer on the owner's recording only", () => {
    const participants = [
      participant("p_owner", "Owner", { role: "organizer" }),
      participant("p_a", "Avi"),
      participant("p_b", "Ben"),
    ]
    const speakers = [
      speaker("sp_1", "Speaker 1", { talkTimeMs: 600_000 }),
      speaker("sp_2", "Speaker 2", { talkTimeMs: 60_000 }),
    ]
    const results = suggestSpeakerMappings(
      input({
        speakers,
        participants,
        meetingSource: "desktop_recorder",
        options: { threshold: 0.1 },
      })
    )

    expect(results).toEqual([
      expect.objectContaining({
        speakerId: "sp_1",
        suggestion: expect.objectContaining({
          participantId: "p_owner",
          reasons: [expect.objectContaining({ kind: "organizer_owner", weight: 0.2 })],
        }),
      }),
    ])
    expect(
      suggestSpeakerMappings(
        input({ speakers, participants, meetingSource: "upload", options: { threshold: 0.1 } })
      )
    ).toEqual([])
  })

  it("uses voiceprints only when enabled", () => {
    const participants = [participant("p_a", "Avi"), participant("p_b", "Ben"), participant("p_c", "Gal")]
    const profiles: SpeakerProfile[] = [
      {
        id: "prof_noa",
        workspaceId: "ws_1",
        displayName: "Noa",
        aliases: [],
        confirmedCount: 5,
        voiceEmbedding: [1, 0, 0],
        embeddingModel: "pyannote",
      },
    ]
    const speakers = [
      speaker("sp_1", "Speaker 1", { embedding: [0.99, 0.05, 0], embeddingModel: "pyannote" }),
      speaker("sp_2", "Speaker 2"),
    ]

    expect(suggestSpeakerMappings(input({ speakers, participants, profiles }))).toEqual([])

    const [result] = suggestSpeakerMappings(
      input({
        speakers,
        participants,
        profiles,
        options: { voiceprintEnabled: true, voiceprintThreshold: 0.72 },
      })
    )

    expect(result.suggestion).toMatchObject({ profileId: "prof_noa" })
    expect(result.suggestion.reasons[0].kind).toBe("voiceprint")
  })
})

describe("refreshSpeakerSuggestions", () => {
  async function seed() {
    const repository = createInMemoryMeetingRepository()
    const meeting = await repository.createMeeting({
      title: "פגישת צוות",
      source: "upload",
      language: "he",
      startedAt: "2026-10-01T09:00:00.000Z",
      participants: ["דנה", "רן", "מאיה"],
    })
    const { speakers } = await repository.replaceTranscript(meeting.id, {
      segments: [
        { id: "s1", speaker: "Speaker 1", startMs: 0, endMs: 3_000, text: "שלום, אני דנה מהשיווק" },
        { id: "s2", speaker: "Speaker 2", startMs: 3_500, endMs: 6_000, text: "ואני רן" },
        { id: "s3", speaker: "Speaker 3", startMs: 6_500, endMs: 9_000, text: "נמשיך" },
      ],
      speakers: [],
    })

    return { repository, meeting, speakers }
  }

  it("stores suggestions, keeps confirmed speakers, clears stale suggestions", async () => {
    const { repository, meeting, speakers } = await seed()
    const [sp1, sp2, sp3] = speakers

    await repository.updateMeetingSpeaker(meeting.id, sp2.id, {
      displayName: "Someone else",
      mappingStatus: "confirmed",
    })
    await repository.setSpeakerSuggestions(meeting.id, [
      {
        speakerId: sp3.id,
        mappingStatus: "suggested",
        suggestion: { name: "Old", score: 0.6, reasons: [], computedAt: NOW.toISOString() },
      },
    ])

    const count = await refreshSpeakerSuggestions(repository, meeting.id, {
      env: {} as NodeJS.ProcessEnv,
      now: NOW,
      loadMeetTimeline: async () => {
        throw new Error("Meet unavailable")
      },
    })
    const after = await repository.listMeetingSpeakers(meeting.id)

    expect(count).toBeGreaterThanOrEqual(1)
    expect(after.find((s) => s.id === sp1.id)).toMatchObject({
      mappingStatus: "suggested",
      suggestion: { name: "דנה" },
    })
    expect(after.find((s) => s.id === sp2.id)).toMatchObject({
      mappingStatus: "confirmed",
      displayName: "Someone else",
    })
    expect(after.find((s) => s.id === sp2.id)?.suggestion).toBeUndefined()
    const third = after.find((s) => s.id === sp3.id)!

    expect(third.suggestion?.name).not.toBe("Old")
  })

  it("never re-suggests the candidate a speaker was rejected for", async () => {
    const { repository, meeting, speakers } = await seed()
    const [sp1] = speakers

    await refreshSpeakerSuggestions(repository, meeting.id, { env: {} as NodeJS.ProcessEnv, now: NOW })
    await repository.updateMeetingSpeaker(meeting.id, sp1.id, { mappingStatus: "rejected" })
    await refreshSpeakerSuggestions(repository, meeting.id, { env: {} as NodeJS.ProcessEnv, now: NOW })

    expect((await repository.listMeetingSpeakers(meeting.id)).find((s) => s.id === sp1.id)).toMatchObject({
      mappingStatus: "rejected",
      suggestion: { name: "דנה" },
    })
  })
})
