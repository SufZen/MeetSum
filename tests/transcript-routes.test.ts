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

const recordAuditLog = vi.hoisted(() => vi.fn(async (input: unknown) => input))

vi.mock("@/lib/audit", () => ({ recordAuditLog }))

import { GET as getTranscript } from "@/app/api/meetings/[id]/transcript/route"
import { PATCH as patchSegment } from "@/app/api/meetings/[id]/transcript/segments/[segmentId]/route"
import { POST as undoSegment } from "@/app/api/meetings/[id]/transcript/segments/[segmentId]/undo/route"
import { GET as listRevisions } from "@/app/api/meetings/[id]/transcript/segments/[segmentId]/revisions/route"
import {
  createInMemoryMeetingDatabase,
  createInMemoryMeetingRepository,
  type InMemoryMeetingDatabase,
} from "@/lib/meetings/repository"
import type {
  SegmentMutationResponse,
  TranscriptResponse,
} from "@/lib/meetings/transcript-wire"
import type { WorkspaceRole } from "@/lib/workspaces/types"

const BASE = "http://localhost/api/meetings"
const SECRET_TEXT = "סוד מסחרי שלא ייכנס ליומן"

async function seed(): Promise<InMemoryMeetingDatabase> {
  const database = createInMemoryMeetingDatabase([
    testMeeting({ id: "m_a", workspaceId: "ws_a" }),
    testMeeting({ id: "m_b", workspaceId: "ws_b" }),
  ])
  const system = createInMemoryMeetingRepository(database, { kind: "system", workspaceId: "ws_a" })

  await system.replaceTranscript("m_a", {
    segments: [
      {
        id: "s1",
        speaker: "Speaker 1",
        startMs: 0,
        endMs: 2000,
        text: "שלום לכולם",
        words: [
          { startMs: 0, endMs: 900, text: "שלום", confidence: 0.9 },
          { startMs: 1000, endMs: 2000, text: "לכולם", confidence: 0.8 },
        ],
      },
      { id: "s2", speaker: "Speaker 2", startMs: 2000, endMs: 4000, text: "היי" },
      { id: "s3", speaker: "Speaker 2", startMs: 4000, endMs: 6000, text: "נתחיל" },
      { id: "s4", speaker: "Speaker 1", startMs: 6000, endMs: 7000, text: "טוב" },
    ],
    speakers: [
      { label: "Speaker 1", talkTimeMs: 3000, wordCount: 3, segmentCount: 2 },
      { label: "Speaker 2", talkTimeMs: 4000, wordCount: 2, segmentCount: 2 },
    ],
  })
  await createInMemoryMeetingRepository(database, {
    kind: "system",
    workspaceId: "ws_b",
  }).replaceTranscript("m_b", {
    segments: [{ id: "sb", speaker: "Speaker 1", startMs: 0, endMs: 1, text: "foreign" }],
    speakers: [{ label: "Speaker 1", talkTimeMs: 1, wordCount: 1, segmentCount: 1 }],
  })

  return database
}

async function useCtx(role: WorkspaceRole = "member", database?: InMemoryMeetingDatabase) {
  const db = database ?? (await seed())

  setRouteCtx(await createTestCtx({ role, workspaceId: "ws_a", database: db }))
  return db
}

function patch(meetingId: string, segmentId: string, body: unknown) {
  return patchSegment(
    jsonRequest(`${BASE}/${meetingId}/transcript/segments/${segmentId}`, "PATCH", body),
    routeParams({ id: meetingId, segmentId })
  )
}

function undo(meetingId: string, segmentId: string, body: unknown) {
  return undoSegment(
    jsonRequest(`${BASE}/${meetingId}/transcript/segments/${segmentId}/undo`, "POST", body),
    routeParams({ id: meetingId, segmentId })
  )
}

function transcript(meetingId: string, headers: Record<string, string> = {}) {
  return getTranscript(
    new Request(`${BASE}/${meetingId}/transcript`, { headers }),
    routeParams({ id: meetingId })
  )
}

beforeAll(() => {
  process.env.MEETSUM_RATE_LIMIT = "false"
})

beforeEach(() => {
  setRouteCtx(undefined)
  recordAuditLog.mockClear()
})

describe("GET /api/meetings/:id/transcript", () => {
  it("returns segments with raw word tuples, speakers and an ETag", async () => {
    await useCtx("viewer")

    const response = await transcript("m_a")
    const body = (await response.json()) as TranscriptResponse

    expect(response.status).toBe(200)
    expect(response.headers.get("etag")).toBe(`"t-m_a-${body.version}"`)
    expect(response.headers.get("cache-control")).toBe("private, no-cache")
    expect(body.language).toBe("he")
    expect(body.segments.map((segment) => segment.id)).toEqual(["s1", "s2", "s3", "s4"])
    expect(body.segments[0].words).toEqual([
      [0, 900, "שלום", 0.9],
      [1000, 2000, "לכולם", 0.8],
    ])
    expect(body.speakers.map((speaker) => speaker.label)).toEqual(["Speaker 1", "Speaker 2"])
  })

  it("answers 304 to a matching If-None-Match (weak or strong) and 200 after an edit", async () => {
    await useCtx()

    const first = await transcript("m_a")
    const etag = first.headers.get("etag") as string

    expect((await transcript("m_a", { "if-none-match": etag })).status).toBe(304)
    expect((await transcript("m_a", { "if-none-match": `W/${etag}, "other"` })).status).toBe(304)

    await patch("m_a", "s2", { revision: 0, text: "היי שוב" })

    const after = await transcript("m_a", { "if-none-match": etag })

    expect(after.status).toBe(200)
    expect(after.headers.get("etag")).not.toBe(etag)
  })

  it("answers 404 for a foreign meeting", async () => {
    await useCtx()

    expect((await transcript("m_b")).status).toBe(404)
  })
})

describe("PATCH /api/meetings/:id/transcript/segments/:segmentId", () => {
  it("edits text, realigns words and audits without the text", async () => {
    await useCtx()

    const response = await patch("m_a", "s1", { revision: 0, text: ` ${SECRET_TEXT} ` })
    const body = (await response.json()) as SegmentMutationResponse

    expect(response.status).toBe(200)
    expect(body.segment).toMatchObject({ id: "s1", text: SECRET_TEXT, revision: 1, source: "edited" })
    expect(body.segment.words?.every((word) => word[5] === 1)).toBe(true)
    expect(body.speakers).toBeUndefined()
    expect(recordAuditLog).toHaveBeenCalledTimes(1)

    const audit = recordAuditLog.mock.calls[0][0] as { action: string; metadata: Record<string, unknown> }

    expect(audit.action).toBe("meeting.transcript.edited")
    expect(audit.metadata).toEqual({
      segmentId: "s1",
      fields: ["text"],
      scope: "segment",
      revision: 1,
      textLength: Array.from(SECRET_TEXT).length,
    })
    expect(JSON.stringify(recordAuditLog.mock.calls)).not.toContain("סוד")
  })

  it("keeps untouched word timings", async () => {
    await useCtx()

    const body = (await (await patch("m_a", "s1", { revision: 0, text: "שלום לכולם!" })).json()) as SegmentMutationResponse

    expect(body.segment.words?.[0]).toEqual([0, 900, "שלום", 0.9])
    expect(body.segment.words?.[1]).toEqual([1000, 2000, "לכולם!", null, null, 1])
  })

  it("answers 409 with the current segment on a stale revision", async () => {
    await useCtx()

    expect((await patch("m_a", "s1", { revision: 0, text: "ראשון" })).status).toBe(200)

    const response = await patch("m_a", "s1", { revision: 0, text: "שני" })
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.error).toBe("conflict")
    expect(body.segment).toMatchObject({ id: "s1", text: "ראשון", revision: 1 })
  })

  it("answers 404 for a foreign meeting or an unknown segment", async () => {
    await useCtx()

    expect((await patch("m_b", "sb", { revision: 0, text: "x" })).status).toBe(404)
    expect((await patch("m_a", "sb", { revision: 0, text: "x" })).status).toBe(404)
    expect((await patch("m_a", "nope", { revision: 0, text: "x" })).status).toBe(404)
  })

  it("forbids viewers", async () => {
    await useCtx("viewer")

    const response = await patch("m_a", "s1", { revision: 0, text: "x" })

    expect(response.status).toBe(403)
    expect((await response.json()).permission).toBe("meeting:write")
  })

  it("validates the body", async () => {
    await useCtx()

    const cases: unknown[] = [
      { text: "x" },
      { revision: -1, text: "x" },
      { revision: 0 },
      { revision: 0, text: "   " },
      { revision: 0, text: "x".repeat(5001) },
      { revision: 0, speakerId: "a", newSpeakerName: "b" },
      { revision: 0, newSpeakerName: " " },
      { revision: 0, text: "x", scope: "meeting" },
      { revision: 0, text: 5 },
    ]

    for (const body of cases) {
      expect((await patch("m_a", "s1", body)).status, JSON.stringify(body).slice(0, 60)).toBe(400)
    }
    expect(recordAuditLog).not.toHaveBeenCalled()
  })

  it("rejects a speaker of another meeting with 400", async () => {
    const db = await useCtx()
    const foreignSpeaker = [...db.speakers.values()].find((speaker) => speaker.meetingId === "m_b")!

    expect((await patch("m_a", "s1", { revision: 0, speakerId: foreignSpeaker.id })).status).toBe(400)
  })

  it("reassigns a whole turn and updates speaker stats", async () => {
    const db = await useCtx()
    const speaker1 = [...db.speakers.values()].find(
      (speaker) => speaker.meetingId === "m_a" && speaker.label === "Speaker 1"
    )!

    const response = await patch("m_a", "s2", {
      revision: 0,
      speakerId: speaker1.id,
      scope: "turn",
    })
    const body = (await response.json()) as SegmentMutationResponse
    const after = (await (await transcript("m_a")).json()) as TranscriptResponse

    expect(response.status).toBe(200)
    expect(after.segments.map((segment) => [segment.id, segment.speakerId, segment.turnIndex])).toEqual([
      ["s1", speaker1.id, 0],
      ["s2", speaker1.id, 0],
      ["s3", speaker1.id, 0],
      ["s4", speaker1.id, 0],
    ])
    expect(body.speakers?.find((speaker) => speaker.id === speaker1.id)).toMatchObject({
      talkTimeMs: 7000,
      segmentCount: 4,
    })
    expect(body.speakers?.find((speaker) => speaker.label === "Speaker 2")).toMatchObject({
      talkTimeMs: 0,
      segmentCount: 0,
    })
    expect((recordAuditLog.mock.calls[0][0] as { metadata: object }).metadata).toMatchObject({
      fields: ["speaker"],
      scope: "turn",
    })
  })

  it("undoes a whole-turn reassignment atomically and returns every segment (M9 B5)", async () => {
    const db = await useCtx()
    const speaker1 = [...db.speakers.values()].find(
      (speaker) => speaker.meetingId === "m_a" && speaker.label === "Speaker 1"
    )!

    await patch("m_a", "s2", { revision: 0, speakerId: speaker1.id, scope: "turn" })

    const response = await undo("m_a", "s3", { revision: 1 })
    const body = (await response.json()) as SegmentMutationResponse
    const after = (await (await transcript("m_a")).json()) as TranscriptResponse
    const speaker2 = after.speakers.find((speaker) => speaker.label === "Speaker 2")!

    expect(response.status).toBe(200)
    expect(body.segments?.map((segment) => segment.id)).toEqual(["s2", "s3"])
    expect(after.segments.map((segment) => [segment.id, segment.speakerId])).toEqual([
      ["s1", speaker1.id],
      ["s2", speaker2.id],
      ["s3", speaker2.id],
      ["s4", speaker1.id],
    ])
    expect(recordAuditLog).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "meeting.transcript.reverted", metadata: expect.objectContaining({ segmentCount: 2 }) })
    )
  })

  it("creates a confirmed manual speaker for newSpeakerName", async () => {
    await useCtx()

    const response = await patch("m_a", "s3", { revision: 0, newSpeakerName: "  דנה   כהן " })
    const body = (await response.json()) as SegmentMutationResponse
    const created = body.speakers?.find((speaker) => speaker.label === "Speaker 3")

    expect(response.status).toBe(200)
    expect(created).toMatchObject({
      displayName: "דנה כהן",
      mappingStatus: "confirmed",
      source: "manual",
      segmentCount: 1,
    })
    expect(body.segment).toMatchObject({ speakerId: created?.id, speaker: "דנה כהן" })
  })
})

describe("POST .../undo and GET .../revisions", () => {
  it("restores the previous state and records the revert", async () => {
    await useCtx()

    await patch("m_a", "s1", { revision: 0, text: "טקסט חדש" })

    const response = await undo("m_a", "s1", { revision: 1 })
    const body = (await response.json()) as SegmentMutationResponse

    expect(response.status).toBe(200)
    expect(body.segment).toMatchObject({ text: "שלום לכולם", revision: 2, source: "asr" })
    expect(body.segment.words?.[0]).toEqual([0, 900, "שלום", 0.9])
    expect(recordAuditLog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "meeting.transcript.reverted",
        metadata: { segmentId: "s1", revision: 2, segmentCount: 1 },
      })
    )

    const revisions = await listRevisions(
      new Request(`${BASE}/m_a/transcript/segments/s1/revisions`),
      routeParams({ id: "m_a", segmentId: "s1" })
    )
    const listed = await revisions.json()

    expect(listed.revisions).toHaveLength(1)
    expect(listed.revisions[0]).toMatchObject({ revision: 0, text: "שלום לכולם" })
    expect(listed.revisions[0].revertedAt).toBeTruthy()
  })

  it("answers 409 nothing_to_undo and conflict", async () => {
    await useCtx()

    const nothing = await undo("m_a", "s1", { revision: 0 })

    expect(nothing.status).toBe(409)
    expect((await nothing.json()).error).toBe("nothing_to_undo")

    await patch("m_a", "s1", { revision: 0, text: "חדש" })

    const stale = await undo("m_a", "s1", { revision: 0 })

    expect(stale.status).toBe(409)
    expect((await stale.json()).error).toBe("conflict")
    expect((await undo("m_a", "s1", { revision: "1" })).status).toBe(400)
  })

  it("forbids viewers from undoing and hides revisions of foreign meetings", async () => {
    await useCtx("viewer")

    expect((await undo("m_a", "s1", { revision: 0 })).status).toBe(403)

    const foreign = await listRevisions(
      new Request(`${BASE}/m_b/transcript/segments/sb/revisions`),
      routeParams({ id: "m_b", segmentId: "sb" })
    )

    expect(foreign.status).toBe(404)
  })
})
