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
const deleteMeetingObjects = vi.hoisted(() =>
  vi.fn(async (keys: readonly string[]) => ({
    deleted: [...keys],
    failed: [] as Array<{ key: string; error: string }>,
  }))
)
const enqueueMeetSumJob = vi.hoisted(() => vi.fn(async () => ({ id: "job_1" })))

vi.mock("@/lib/audit", () => ({ recordAuditLog }))
vi.mock("@/lib/storage/object-storage", () => ({ deleteMeetingObjects }))
vi.mock("@/lib/jobs/queue", () => ({ enqueueMeetSumJob }))

import { DELETE, GET, PATCH } from "@/app/api/meetings/[id]/route"
import {
  createInMemoryMeetingDatabase,
  createInMemoryMeetingRepository,
  type InMemoryMeetingDatabase,
  type MeetingRecord,
} from "@/lib/meetings/repository"
import type { MeetingDetailResponse } from "@/lib/meetings/transcript-wire"

const BASE = "http://localhost/api/meetings"

async function seed(): Promise<InMemoryMeetingDatabase> {
  const database = createInMemoryMeetingDatabase([
    testMeeting({ id: "m_mine", ownerUserId: "user_me", title: "Mine" }),
    testMeeting({ id: "m_other", ownerUserId: "user_other", title: "Theirs" }),
    testMeeting({ id: "m_private", ownerUserId: "user_other", visibility: "private" }),
    testMeeting({ id: "m_foreign", workspaceId: "ws_b" }),
  ])
  const system = createInMemoryMeetingRepository(database, { kind: "system", workspaceId: "ws_a" })

  const original = await system.createMediaAsset({
    meetingId: "m_other",
    storageKey: "meetings/m_other/a.webm",
    contentType: "audio/webm",
    sizeBytes: 10,
  })
  await system.updateMediaAssetPreparation(original.id, {
    peaksStorageKey: "meetings/m_other/derived/a.peaks.v1.json",
    durationMs: 61_000,
  })
  await system.createMediaAsset({
    meetingId: "m_other",
    storageKey: "meetings/m_other/derived/a.m4a",
    contentType: "audio/mp4",
    sizeBytes: 5,
    kind: "playback",
    derivedFromAssetId: original.id,
  })
  await system.replaceTranscript("m_other", {
    segments: [
      {
        id: "s1",
        speaker: "Speaker 1",
        startMs: 0,
        endMs: 1000,
        text: "שלום",
        words: [{ startMs: 0, endMs: 1000, text: "שלום", confidence: 0.9 }],
      },
    ],
    speakers: [{ label: "Speaker 1", talkTimeMs: 1000, wordCount: 1, segmentCount: 1 }],
  })

  return database
}

async function useCtx(
  options: Parameters<typeof createTestCtx>[0] = {},
  database?: InMemoryMeetingDatabase
) {
  const db = database ?? (await seed())

  setRouteCtx(await createTestCtx({ workspaceId: "ws_a", database: db, ...options }))
  return db
}

function get(id: string, query = "") {
  return GET(new Request(`${BASE}/${id}${query}`), routeParams({ id }))
}

function rename(id: string, body: unknown) {
  return PATCH(jsonRequest(`${BASE}/${id}`, "PATCH", body), routeParams({ id }))
}

function remove(id: string) {
  return DELETE(jsonRequest(`${BASE}/${id}`, "DELETE"), routeParams({ id }))
}

beforeAll(() => {
  process.env.MEETSUM_RATE_LIMIT = "false"
})

beforeEach(() => {
  setRouteCtx(undefined)
  recordAuditLog.mockClear()
  deleteMeetingObjects.mockClear()
  enqueueMeetSumJob.mockClear()
})

describe("GET /api/meetings/:id", () => {
  it("returns the detail without the transcript, with counts and permissions", async () => {
    await useCtx({ role: "member" })

    const response = await get("m_other")
    const body = (await response.json()) as MeetingDetailResponse

    expect(response.status).toBe(200)
    expect(body.meeting.transcript).toBeUndefined()
    expect(body.meeting).toMatchObject({
      id: "m_other",
      transcriptSegmentCount: 1,
      editedSegmentCount: 0,
      durationMs: 61_000,
    })
    expect(body.meeting.transcriptVersion).toBeGreaterThan(0)
    expect(body.permissions).toEqual({ canWrite: true, canManage: false })
  })

  it("reports manage rights for the owner and admins, read-only for viewers", async () => {
    await useCtx({ role: "member" })
    expect(((await (await get("m_mine")).json()) as MeetingDetailResponse).permissions).toEqual({
      canWrite: true,
      canManage: true,
    })

    await useCtx({ role: "admin" })
    expect(((await (await get("m_other")).json()) as MeetingDetailResponse).permissions).toEqual({
      canWrite: true,
      canManage: true,
    })

    await useCtx({ role: "viewer" })
    expect(((await (await get("m_other")).json()) as MeetingDetailResponse).permissions).toEqual({
      canWrite: false,
      canManage: false,
    })
  })

  it("includes segments without words with ?include=transcript", async () => {
    await useCtx({ role: "viewer" })

    const body = (await (await get("m_other", "?include=transcript")).json()) as MeetingDetailResponse

    expect(body.meeting.transcript).toEqual([
      expect.objectContaining({ id: "s1", text: "שלום", speaker: "Speaker 1" }),
    ])
    expect(body.meeting.transcript?.[0].words).toBeUndefined()
  })

  it("answers 404 for invisible and foreign meetings", async () => {
    await useCtx({ role: "member" })

    expect((await get("m_private")).status).toBe(404)
    expect((await get("m_foreign")).status).toBe(404)
  })
})

describe("PATCH /api/meetings/:id (rename)", () => {
  it("renames for any member and audits from/to", async () => {
    const db = await useCtx({ role: "member" })

    const response = await rename("m_other", { title: "  סיכום רבעוני  " })

    expect(response.status).toBe(200)
    expect((await response.json()).meeting.title).toBe("סיכום רבעוני")
    expect(db.meetings.get("m_other")?.title).toBe("סיכום רבעוני")
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "meeting.renamed",
        workspaceId: "ws_a",
        targetId: "m_other",
        metadata: { from: "Theirs", to: "סיכום רבעוני" },
      })
    )
  })

  it("validates the title and forbids viewers", async () => {
    await useCtx({ role: "member" })

    expect((await rename("m_other", {})).status).toBe(400)
    expect((await rename("m_other", { title: "   " })).status).toBe(400)
    expect((await rename("m_other", { title: "x".repeat(201) })).status).toBe(400)
    expect((await rename("m_other", { title: "x".repeat(200) })).status).toBe(200)
    expect((await rename("m_private", { title: "x" })).status).toBe(404)

    await useCtx({ role: "viewer" })
    expect((await rename("m_other", { title: "x" })).status).toBe(403)
  })
})

describe("DELETE /api/meetings/:id", () => {
  it("forbids a member who does not own the meeting", async () => {
    const db = await useCtx({ role: "member" })

    const response = await remove("m_other")

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "Forbidden", permission: "meeting:manage" })
    expect(db.meetings.has("m_other")).toBe(true)
    expect(deleteMeetingObjects).not.toHaveBeenCalled()
  })

  it("lets the owner delete and removes media, renditions and peaks objects", async () => {
    const db = await useCtx({ role: "member", userId: "user_other" })

    const response = await remove("m_other")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ deleted: true })
    expect(db.meetings.has("m_other")).toBe(false)
    expect([...db.speakers.values()].some((speaker) => speaker.meetingId === "m_other")).toBe(false)
    expect(deleteMeetingObjects).toHaveBeenCalledWith([
      "meetings/m_other/a.webm",
      "meetings/m_other/derived/a.peaks.v1.json",
      "meetings/m_other/derived/a.m4a",
    ])
    expect(enqueueMeetSumJob).not.toHaveBeenCalled()
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "meeting.deleted",
        targetId: "m_other",
        metadata: { title: "Theirs", assetCount: 2, objectDeleteFailures: 0 },
      })
    )
  })

  it("lets an admin delete any visible meeting", async () => {
    await useCtx({ role: "admin" })

    expect((await remove("m_mine")).status).toBe(200)
  })

  it("queues storage.delete for objects that failed to delete", async () => {
    await useCtx({ role: "admin" })
    deleteMeetingObjects.mockResolvedValueOnce({
      deleted: ["meetings/m_other/a.webm"],
      failed: [
        { key: "meetings/m_other/derived/a.peaks.v1.json", error: "boom" },
        { key: "meetings/m_other/derived/a.m4a", error: "boom" },
      ],
    })

    const response = await remove("m_other")

    expect(response.status).toBe(200)
    expect(enqueueMeetSumJob).toHaveBeenCalledWith("storage.delete", {
      workspaceId: "ws_a",
      keys: ["meetings/m_other/derived/a.peaks.v1.json", "meetings/m_other/derived/a.m4a"],
    })
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ objectDeleteFailures: 2 }),
      })
    )
  })

  it("queues every key when the storage call throws", async () => {
    await useCtx({ role: "admin" })
    deleteMeetingObjects.mockRejectedValueOnce(new Error("S3 down"))

    expect((await remove("m_other")).status).toBe(200)
    expect(enqueueMeetSumJob).toHaveBeenCalledWith(
      "storage.delete",
      expect.objectContaining({ keys: expect.arrayContaining(["meetings/m_other/a.webm"]) })
    )
  })

  it("answers 404 for invisible and foreign meetings", async () => {
    await useCtx({ role: "admin" })

    expect((await remove("m_foreign")).status).toBe(404)

    await useCtx({ role: "member" })
    expect((await remove("m_private")).status).toBe(404)
  })

  it("requires the admin scope for API keys", async () => {
    const db = await seed()

    await useCtx({ role: "member", principal: "api_key", apiKeyCreatedBy: "user_other" }, db)
    expect((await remove("m_other")).status).toBe(403)

    await useCtx({ role: "admin", principal: "api_key" }, db)
    expect((await remove("m_other")).status).toBe(200)
    expect((db.meetings.get("m_other") as MeetingRecord | undefined)).toBeUndefined()
  })
})
