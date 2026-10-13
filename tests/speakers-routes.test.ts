import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createTestCtx,
  jsonRequest,
  routeParams,
  setRouteCtx,
  testMeeting,
} from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

const recordAuditLog = vi.hoisted(() => vi.fn(async () => undefined))
const refreshSpeakerSuggestions = vi.hoisted(() => vi.fn(async () => 1))

vi.mock("@/lib/audit", () => ({ recordAuditLog }))
vi.mock("@/lib/meetings/speakers/suggest", () => ({ refreshSpeakerSuggestions }))

import { GET as listSpeakers, POST as legacyMap } from "@/app/api/meetings/[id]/speakers/route"
import { POST as legacyAssign } from "@/app/api/meetings/[id]/speakers/assign/route"
import { PATCH as patchSpeaker } from "@/app/api/meetings/[id]/speakers/[speakerId]/route"
import { POST as suggestSpeakers } from "@/app/api/meetings/[id]/speakers/suggest/route"
import { POST as mergeSpeakers } from "@/app/api/meetings/[id]/speakers/merge/route"
import type { AuthContext } from "@/lib/auth/authz"
import {
  createInMemoryMeetingDatabase,
  createInMemoryMeetingRepository,
  type MeetingParticipant,
  type MeetingSpeaker,
  type MeetingSpeakerPatch,
} from "@/lib/meetings/repository"
import type { WorkspaceRole } from "@/lib/workspaces/types"

const BASE = "http://localhost/api/meetings"

function speaker(overrides: Partial<MeetingSpeaker> & { id: string; label: string }): MeetingSpeaker {
  return {
    meetingId: "m_a",
    mappingStatus: "unmapped",
    source: "asr",
    talkTimeMs: 1000,
    wordCount: 10,
    segmentCount: 1,
    ...overrides,
  }
}

type Setup = {
  ctx: AuthContext
  speakers: MeetingSpeaker[]
  participants: MeetingParticipant[]
  mocks: {
    listMeetingSpeakers: ReturnType<typeof vi.fn>
    updateMeetingSpeaker: ReturnType<typeof vi.fn>
    recordConfirmedSpeaker: ReturnType<typeof vi.fn>
    mergeMeetingSpeakers: ReturnType<typeof vi.fn>
    replaceTranscript: ReturnType<typeof vi.fn>
    replaceTranscriptSegments: ReturnType<typeof vi.fn>
  }
}

/** W1 meeting with two diarized speakers; W2 meeting with its own speaker. */
async function setup(role: WorkspaceRole = "member"): Promise<Setup> {
  const database = createInMemoryMeetingDatabase([
    testMeeting({
      id: "m_a",
      workspaceId: "ws_a",
      participants: ["Dana Cohen", "Avi Levi"],
      transcript: [
        { id: "s1", speaker: "Speaker 1", speakerId: "spk_1", startMs: 0, endMs: 1000, text: "שלום, אני דנה" },
        { id: "s2", speaker: "Speaker 2", speakerId: "spk_2", startMs: 1000, endMs: 2000, text: "היי" },
        { id: "s3", speaker: "Speaker 1", speakerId: "spk_1", startMs: 2000, endMs: 3000, text: "נתחיל" },
      ],
    }),
    testMeeting({ id: "m_b", workspaceId: "ws_b", participants: ["Other"] }),
  ])
  const ctx = await createTestCtx({ role, workspaceId: "ws_a", database })
  const system = createInMemoryMeetingRepository(database, { kind: "system", workspaceId: "ws_a" })
  const participants = await system.listMeetingParticipants("m_a")
  const dana = participants.find((participant) => participant.name === "Dana Cohen")!
  const speakers = [
    speaker({
      id: "spk_1",
      label: "Speaker 1",
      talkTimeMs: 2000,
      mappingStatus: "suggested",
      suggestion: {
        participantId: dana.id,
        name: "Dana Cohen",
        score: 0.8,
        reasons: [{ kind: "self_intro", detail: "אני דנה", weight: 0.75 }],
        computedAt: "2026-10-13T00:00:00.000Z",
      },
    }),
    speaker({ id: "spk_2", label: "Speaker 2", talkTimeMs: 1000 }),
  ]
  const listMeetingSpeakers = vi.fn(async (meetingId: string) =>
    meetingId === "m_a" ? speakers : [speaker({ id: "spk_b", label: "Speaker 1", meetingId })]
  )
  const updateMeetingSpeaker = vi.fn(
    async (_meetingId: string, speakerId: string, patch: MeetingSpeakerPatch) => {
      const current = speakers.find((candidate) => candidate.id === speakerId)!

      return {
        ...current,
        ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value ?? undefined])),
      } as MeetingSpeaker
    }
  )
  const recordConfirmedSpeaker = vi.fn(async () => ({
    id: "prof_1",
    workspaceId: "ws_a",
    displayName: "Dana Cohen",
    aliases: [],
    confirmedCount: 1,
  }))
  const mergeMeetingSpeakers = vi.fn(async () => ({ ...speakers[1], talkTimeMs: 3000 }))
  const replaceTranscript = vi.fn()
  const replaceTranscriptSegments = vi.fn()

  Object.assign(ctx.meetings, {
    listMeetingSpeakers,
    updateMeetingSpeaker,
    recordConfirmedSpeaker,
    mergeMeetingSpeakers,
    replaceTranscript,
    replaceTranscriptSegments,
  })

  return {
    ctx,
    speakers,
    participants,
    mocks: {
      listMeetingSpeakers,
      updateMeetingSpeaker,
      recordConfirmedSpeaker,
      mergeMeetingSpeakers,
      replaceTranscript,
      replaceTranscriptSegments,
    },
  }
}

function patch(meetingId: string, speakerId: string, body: unknown) {
  return patchSpeaker(
    jsonRequest(`${BASE}/${meetingId}/speakers/${speakerId}`, "PATCH", body),
    routeParams({ id: meetingId, speakerId })
  )
}

beforeAll(() => {
  process.env.MEETSUM_RATE_LIMIT = "false"
})

beforeEach(() => {
  setRouteCtx(undefined)
  recordAuditLog.mockClear()
  refreshSpeakerSuggestions.mockClear()
})

describe("GET /api/meetings/:id/speakers", () => {
  it("lists speakers, participants and the total talk time", async () => {
    const { ctx } = await setup("viewer")
    setRouteCtx(ctx)

    const response = await listSpeakers(
      new Request(`${BASE}/m_a/speakers`),
      routeParams({ id: "m_a" })
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.speakers.map((item: MeetingSpeaker) => item.id)).toEqual(["spk_1", "spk_2"])
    expect(body.participants.map((item: MeetingParticipant) => item.name).sort()).toEqual([
      "Avi Levi",
      "Dana Cohen",
    ])
    expect(body.totalTalkTimeMs).toBe(3000)
  })

  it("answers 404 for a foreign meeting", async () => {
    const { ctx, mocks } = await setup()
    setRouteCtx(ctx)

    const response = await listSpeakers(
      new Request(`${BASE}/m_b/speakers`),
      routeParams({ id: "m_b" })
    )

    expect(response.status).toBe(404)
    expect(mocks.listMeetingSpeakers).not.toHaveBeenCalled()
  })
})

describe("PATCH /api/meetings/:id/speakers/:speakerId", () => {
  it("confirms a participant and writes the workspace profile", async () => {
    const { ctx, mocks, participants } = await setup()
    const avi = participants.find((participant) => participant.name === "Avi Levi")!
    setRouteCtx(ctx)

    const response = await patch("m_a", "spk_2", { action: "confirm", participantId: avi.id })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.speaker).toMatchObject({ id: "spk_2", mappingStatus: "confirmed", participantId: avi.id })
    expect(mocks.updateMeetingSpeaker).toHaveBeenCalledWith(
      "m_a",
      "spk_2",
      expect.objectContaining({ mappingStatus: "confirmed", participantId: avi.id, confirmedByUserId: "user_me" })
    )
    expect(mocks.recordConfirmedSpeaker).toHaveBeenCalledWith({
      meetingId: "m_a",
      speakerId: "spk_2",
      participant: { name: "Avi Levi" },
      aliases: [],
    })
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "meeting.speaker.mapped",
        workspaceId: "ws_a",
        targetId: "m_a",
        metadata: expect.objectContaining({ operation: "confirm", speakerId: "spk_2" }),
      })
    )
    expect(mocks.replaceTranscript).not.toHaveBeenCalled()
    expect(mocks.replaceTranscriptSegments).not.toHaveBeenCalled()
  })

  it("accepts the current suggestion when no target is given", async () => {
    const { ctx, mocks, speakers } = await setup()
    setRouteCtx(ctx)

    const response = await patch("m_a", "spk_1", { action: "confirm" })

    expect(response.status).toBe(200)
    expect(mocks.updateMeetingSpeaker).toHaveBeenCalledWith(
      "m_a",
      "spk_1",
      expect.objectContaining({ participantId: speakers[0].suggestion?.participantId })
    )
    expect(mocks.recordConfirmedSpeaker).toHaveBeenCalledWith(
      expect.objectContaining({ participant: { name: "Dana Cohen" } })
    )
  })

  it("confirms a typed display name and keeps it as an alias", async () => {
    const { ctx, mocks } = await setup()
    setRouteCtx(ctx)

    const response = await patch("m_a", "spk_2", { action: "confirm", displayName: "  רונית  " })

    expect(response.status).toBe(200)
    expect(mocks.updateMeetingSpeaker).toHaveBeenCalledWith(
      "m_a",
      "spk_2",
      expect.objectContaining({ displayName: "רונית", participantId: null })
    )
    expect(mocks.recordConfirmedSpeaker).toHaveBeenCalledWith(
      expect.objectContaining({ participant: { name: "רונית" }, aliases: [] })
    )
  })

  it("rejects a suggestion and records the rejected candidate", async () => {
    const { ctx, mocks, speakers } = await setup()
    setRouteCtx(ctx)

    const response = await patch("m_a", "spk_1", { action: "reject" })

    expect(response.status).toBe(200)
    expect(mocks.updateMeetingSpeaker).toHaveBeenCalledWith(
      "m_a",
      "spk_1",
      expect.objectContaining({ mappingStatus: "rejected", participantId: null })
    )
    // The suggestion stays on the row: that is the rejected (speaker, candidate) pair.
    expect(mocks.updateMeetingSpeaker.mock.calls[0][2]).not.toHaveProperty("suggestion")
    expect(mocks.recordConfirmedSpeaker).not.toHaveBeenCalled()
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          operation: "reject",
          rejectedCandidate: speakers[0].suggestion?.participantId,
        }),
      })
    )
  })

  it("resets a speaker to unmapped", async () => {
    const { ctx, mocks } = await setup()
    setRouteCtx(ctx)

    const response = await patch("m_a", "spk_1", { action: "reset" })

    expect(response.status).toBe(200)
    expect(mocks.updateMeetingSpeaker).toHaveBeenCalledWith("m_a", "spk_1", {
      mappingStatus: "unmapped",
      participantId: null,
      displayName: null,
      profileId: null,
      suggestion: null,
      confirmedByUserId: null,
    })
  })

  it("answers 404 for an unknown speaker or a foreign participant", async () => {
    const { ctx, mocks } = await setup()
    setRouteCtx(ctx)

    expect((await patch("m_a", "spk_nope", { action: "reject" })).status).toBe(404)
    expect(
      (await patch("m_a", "spk_2", { action: "confirm", participantId: "participant_foreign" })).status
    ).toBe(404)
    expect(mocks.updateMeetingSpeaker).not.toHaveBeenCalled()
  })

  it("answers 404 for a foreign meeting without writing", async () => {
    const { ctx, mocks } = await setup()
    setRouteCtx(ctx)

    const response = await patch("m_b", "spk_b", { action: "confirm", displayName: "x" })

    expect(response.status).toBe(404)
    expect(mocks.updateMeetingSpeaker).not.toHaveBeenCalled()
    expect(mocks.recordConfirmedSpeaker).not.toHaveBeenCalled()
  })

  it("answers 403 for a viewer", async () => {
    const { ctx, mocks } = await setup("viewer")
    setRouteCtx(ctx)

    const response = await patch("m_a", "spk_1", { action: "confirm" })

    expect(response.status).toBe(403)
    expect(mocks.updateMeetingSpeaker).not.toHaveBeenCalled()
  })

  it("validates the action and the confirm target", async () => {
    const { ctx } = await setup()
    setRouteCtx(ctx)

    expect((await patch("m_a", "spk_1", { action: "delete" })).status).toBe(400)
    expect((await patch("m_a", "spk_2", { action: "confirm" })).status).toBe(400)
    expect((await patch("m_a", "spk_2", { action: "confirm", displayName: 5 })).status).toBe(400)
  })
})

describe("POST /api/meetings/:id/speakers/suggest", () => {
  it("recomputes suggestions and returns the speakers", async () => {
    const { ctx } = await setup()
    setRouteCtx(ctx)

    const response = await suggestSpeakers(
      jsonRequest(`${BASE}/m_a/speakers/suggest`, "POST"),
      routeParams({ id: "m_a" })
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.suggested).toBe(1)
    expect(body.speakers).toHaveLength(2)
    expect(refreshSpeakerSuggestions).toHaveBeenCalledWith(ctx.meetings, "m_a")
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "meeting.speaker.suggested", workspaceId: "ws_a" })
    )
  })

  it("answers 404 for a foreign meeting and 403 for a viewer", async () => {
    const member = await setup()
    setRouteCtx(member.ctx)
    expect(
      (await suggestSpeakers(jsonRequest(`${BASE}/m_b/speakers/suggest`, "POST"), routeParams({ id: "m_b" }))).status
    ).toBe(404)

    const viewer = await setup("viewer")
    setRouteCtx(viewer.ctx)
    expect(
      (await suggestSpeakers(jsonRequest(`${BASE}/m_a/speakers/suggest`, "POST"), routeParams({ id: "m_a" }))).status
    ).toBe(403)
    expect(refreshSpeakerSuggestions).not.toHaveBeenCalled()
  })
})

describe("POST /api/meetings/:id/speakers/merge", () => {
  const merge = (meetingId: string, body: unknown) =>
    mergeSpeakers(jsonRequest(`${BASE}/${meetingId}/speakers/merge`, "POST", body), routeParams({ id: meetingId }))

  it("merges two speakers of the meeting and audits it", async () => {
    const { ctx, mocks } = await setup()
    setRouteCtx(ctx)

    const response = await merge("m_a", { sourceSpeakerId: "spk_1", targetSpeakerId: "spk_2" })

    expect(response.status).toBe(200)
    expect(mocks.mergeMeetingSpeakers).toHaveBeenCalledWith("m_a", "spk_1", "spk_2")
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "meeting.speaker.merged", workspaceId: "ws_a" })
    )
    expect(mocks.replaceTranscriptSegments).not.toHaveBeenCalled()
  })

  it("rejects invalid, self and unknown merges", async () => {
    const { ctx, mocks } = await setup()
    setRouteCtx(ctx)

    expect((await merge("m_a", {})).status).toBe(400)
    expect((await merge("m_a", { sourceSpeakerId: "spk_1", targetSpeakerId: "spk_1" })).status).toBe(400)
    expect((await merge("m_a", { sourceSpeakerId: "spk_1", targetSpeakerId: "spk_b" })).status).toBe(404)
    expect((await merge("m_b", { sourceSpeakerId: "spk_b", targetSpeakerId: "spk_1" })).status).toBe(404)
    expect(mocks.mergeMeetingSpeakers).not.toHaveBeenCalled()
  })

  it("answers 403 for a viewer", async () => {
    const { ctx, mocks } = await setup("viewer")
    setRouteCtx(ctx)

    expect((await merge("m_a", { sourceSpeakerId: "spk_1", targetSpeakerId: "spk_2" })).status).toBe(403)
    expect(mocks.mergeMeetingSpeakers).not.toHaveBeenCalled()
  })
})

describe("legacy speaker routes", () => {
  it("POST /speakers confirms speaker rows without rewriting segments", async () => {
    const { ctx, mocks, participants } = await setup()
    const dana = participants.find((participant) => participant.name === "Dana Cohen")!
    setRouteCtx(ctx)

    const response = await legacyMap(
      jsonRequest(`${BASE}/m_a/speakers`, "POST", {
        mappings: [
          { speaker: "Speaker 1", person: "dana cohen" },
          { speaker: "Speaker 2", person: "Guest" },
          { speaker: "Speaker 9", person: "Nobody" },
        ],
      }),
      routeParams({ id: "m_a" })
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ mappingsApplied: 2, segmentsUpdated: 3, totalSegments: 3 })
    expect(mocks.updateMeetingSpeaker).toHaveBeenCalledWith(
      "m_a",
      "spk_1",
      expect.objectContaining({ mappingStatus: "confirmed", participantId: dana.id })
    )
    expect(mocks.updateMeetingSpeaker).toHaveBeenCalledWith(
      "m_a",
      "spk_2",
      expect.objectContaining({ mappingStatus: "confirmed", displayName: "Guest", participantId: null })
    )
    expect(mocks.replaceTranscript).not.toHaveBeenCalled()
    expect(mocks.replaceTranscriptSegments).not.toHaveBeenCalled()
  })

  it("POST /speakers keeps its validation errors", async () => {
    const { ctx } = await setup()
    setRouteCtx(ctx)

    const response = await legacyMap(
      jsonRequest(`${BASE}/m_a/speakers`, "POST", { mappings: [] }),
      routeParams({ id: "m_a" })
    )

    expect(response.status).toBe(400)
  })

  it("POST /speakers/assign confirms the speaker row and returns the participant", async () => {
    const { ctx, mocks, participants } = await setup()
    const avi = participants.find((participant) => participant.name === "Avi Levi")!
    setRouteCtx(ctx)

    const response = await legacyAssign(
      jsonRequest(`${BASE}/m_a/speakers/assign`, "POST", {
        speakerLabel: "Speaker 2",
        participantId: avi.id,
      }),
      routeParams({ id: "m_a" })
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.participant).toMatchObject({ id: avi.id, name: "Avi Levi", speakerLabel: "Speaker 2" })
    expect(mocks.updateMeetingSpeaker).toHaveBeenCalledWith(
      "m_a",
      "spk_2",
      expect.objectContaining({ mappingStatus: "confirmed", participantId: avi.id })
    )
    expect(mocks.recordConfirmedSpeaker).toHaveBeenCalled()
    expect(mocks.replaceTranscript).not.toHaveBeenCalled()
    expect(mocks.replaceTranscriptSegments).not.toHaveBeenCalled()
  })

  it("POST /speakers/assign answers 404 for an unknown speaker label", async () => {
    const { ctx, mocks, participants } = await setup()
    setRouteCtx(ctx)

    const response = await legacyAssign(
      jsonRequest(`${BASE}/m_a/speakers/assign`, "POST", {
        speakerLabel: "Speaker 7",
        participantId: participants[0].id,
      }),
      routeParams({ id: "m_a" })
    )

    expect(response.status).toBe(404)
    expect(mocks.updateMeetingSpeaker).not.toHaveBeenCalled()
  })
})
