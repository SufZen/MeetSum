import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, jsonRequest, routeParams, setRouteCtx, testMeeting } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

const recordAuditLog = vi.hoisted(() => vi.fn(async () => undefined))
const enqueueMeetSumJob = vi.hoisted(() => vi.fn(async () => ({ id: "job_1" })))
const settings = vi.hoisted(() => ({ publicSharingEnabled: true }))

vi.mock("@/lib/audit", () => ({ recordAuditLog }))
vi.mock("@/lib/jobs/queue", () => ({ enqueueMeetSumJob }))
vi.mock("@/lib/settings/app-settings", () => ({ getAppSettings: async () => settings }))

import { POST as shareClip } from "@/app/api/clips/[id]/share/route"
import { DELETE as deleteClip, GET as getClip, PATCH as patchClip } from "@/app/api/clips/[id]/route"
import { GET as listClips, POST as createClip } from "@/app/api/meetings/[id]/clips/route"
import { createCollabMemoryDb, setCollabBackendForTesting, type CollabMemoryDb } from "@/lib/clips/db"
import { createInMemoryMeetingDatabase, type InMemoryMeetingDatabase } from "@/lib/meetings/repository"
import type { WorkspaceRole } from "@/lib/workspaces/types"

/**
 * M5 C1/C2 clip routes: permissions (viewer reads, member creates),
 * invisible/foreign meetings as 404, range errors, render enqueue, audit
 * without transcript text, author-or-manager rename/delete, and clip share
 * rules (owner/admin, 409 private, sharing switch).
 */

const BASE = "http://localhost/api"
const SEGMENTS = [
  { id: "s1", speaker: "Dana", startMs: 0, endMs: 5000, text: "פתיחה ועדכונים" },
  { id: "s2", speaker: "Avi", startMs: 5000, endMs: 12_000, text: "החלטנו להשיק בנובמבר" },
]

describe("clip routes", () => {
  let collab: CollabMemoryDb
  let database: InMemoryMeetingDatabase

  beforeEach(() => {
    vi.clearAllMocks()
    settings.publicSharingEnabled = true
    collab = createCollabMemoryDb()
    setCollabBackendForTesting({ kind: "memory", db: collab })
    database = createInMemoryMeetingDatabase([
      testMeeting({ id: "m_a", ownerUserId: "user_owner", transcript: SEGMENTS, durationMs: 12_000 }),
      testMeeting({
        id: "m_private",
        visibility: "private",
        ownerUserId: "user_me",
        transcript: SEGMENTS,
        durationMs: 12_000,
      }),
      testMeeting({ id: "m_hidden", visibility: "private", ownerUserId: "user_owner", transcript: SEGMENTS }),
      testMeeting({ id: "m_b", workspaceId: "ws_b", transcript: SEGMENTS, durationMs: 12_000 }),
    ])
  })

  afterEach(() => {
    setRouteCtx(undefined)
    setCollabBackendForTesting(undefined)
  })

  async function as(role: WorkspaceRole, userId = "user_me", principal: "user" | "api_key" = "user") {
    setRouteCtx(await createTestCtx({ role, userId, principal, database }))
  }

  async function create(meetingId: string, body: unknown) {
    return createClip(jsonRequest(`${BASE}/meetings/${meetingId}/clips`, "POST", body), routeParams({ id: meetingId }))
  }

  it("creates a clip from segments, enqueues its render and audits without text", async () => {
    await as("member")

    const response = await create("m_a", { segmentIds: ["s2"] })
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body.clip).toMatchObject({ meetingId: "m_a", startMs: 5000, endMs: 12_000, renderStatus: "pending" })
    expect(body.clip).not.toHaveProperty("storageKey")
    expect(body.clip).not.toHaveProperty("workspaceId")
    expect(enqueueMeetSumJob).toHaveBeenCalledWith("clip.render", {
      workspaceId: "ws_a",
      meetingId: "m_a",
      clipId: body.clip.id,
    })
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "clip.created", workspaceId: "ws_a", targetId: body.clip.id })
    )
    expect(JSON.stringify(recordAuditLog.mock.calls)).not.toContain("החלטנו")
  })

  it("keeps the clip when the render enqueue fails", async () => {
    await as("member")
    enqueueMeetSumJob.mockRejectedValueOnce(new Error("redis down"))
    vi.spyOn(console, "error").mockImplementation(() => undefined)

    expect((await create("m_a", { startMs: 0, endMs: 4000 })).status).toBe(201)
    expect(collab.clips.size).toBe(1)
  })

  it("rejects bad ranges with their code", async () => {
    await as("member")

    expect(await (await create("m_a", { startMs: 0, endMs: 1500 })).json()).toEqual({ error: "too_short" })
    expect((await create("m_a", { startMs: 0, endMs: 60_000 })).status).toBe(400)
    expect((await create("m_a", { segmentIds: ["nope"] })).status).toBe(400)
    expect((await create("m_a", { foo: 1 })).status).toBe(400)
  })

  it("answers 404 for invisible and foreign meetings", async () => {
    await as("member")

    expect((await create("m_hidden", { startMs: 0, endMs: 4000 })).status).toBe(404)
    expect((await create("m_b", { startMs: 0, endMs: 4000 })).status).toBe(404)
    expect(
      (await listClips(new Request(`${BASE}/meetings/m_b/clips`), routeParams({ id: "m_b" }))).status
    ).toBe(404)
  })

  it("lets viewers list but not create", async () => {
    await as("member", "user_author")
    await create("m_a", { startMs: 0, endMs: 4000 })
    await as("viewer")

    const list = await listClips(new Request(`${BASE}/meetings/m_a/clips`), routeParams({ id: "m_a" }))
    const body = await list.json()

    expect(list.status).toBe(200)
    expect(body.clips).toHaveLength(1)
    expect(body.clips[0].canManage).toBe(false)
    expect((await create("m_a", { startMs: 0, endMs: 4000 })).status).toBe(403)
  })

  it("lets only the author or a meeting manager rename and delete", async () => {
    await as("member", "user_author")

    const { clip } = await (await create("m_a", { startMs: 0, endMs: 4000 })).json()
    const patch = (title: string) =>
      patchClip(jsonRequest(`${BASE}/clips/${clip.id}`, "PATCH", { title }), routeParams({ id: clip.id }))
    const remove = () => deleteClip(new Request(`${BASE}/clips/${clip.id}`, { method: "DELETE" }), routeParams({ id: clip.id }))

    await as("member", "user_other")
    expect((await patch("x")).status).toBe(403)
    expect((await remove()).status).toBe(403)

    await as("member", "user_author")
    expect(await (await patch("  פתיחה  ")).json()).toMatchObject({ clip: { title: "פתיחה" } })
    expect((await patch("   ")).status).toBe(400)

    await as("member", "user_owner")
    expect((await remove()).status).toBe(200)
    expect((await getClip(new Request(`${BASE}/clips/${clip.id}`), routeParams({ id: clip.id }))).status).toBe(404)
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "clip.deleted" }))
  })

  it("hides clips of meetings the caller cannot see", async () => {
    await as("member", "user_owner")

    const { clip } = await (await create("m_hidden", { startMs: 0, endMs: 4000 })).json()

    await as("admin", "user_admin")
    expect((await getClip(new Request(`${BASE}/clips/${clip.id}`), routeParams({ id: clip.id }))).status).toBe(404)
  })

  it("shares a clip for meeting managers only, never for private meetings", async () => {
    await as("member", "user_me")

    const { clip: privateClip } = await (await create("m_private", { startMs: 0, endMs: 4000 })).json()
    const { clip } = await (await create("m_a", { startMs: 0, endMs: 4000 })).json()
    const share = (id: string) =>
      shareClip(new Request(`${BASE}/clips/${id}/share`, { method: "POST" }), routeParams({ id }))

    expect(await (await share(privateClip.id)).json()).toEqual({ error: "meeting_private" })
    expect((await share(privateClip.id)).status).toBe(409)
    // user_me authored the clip but does not own m_a.
    expect((await share(clip.id)).status).toBe(403)

    await as("member", "user_owner")
    settings.publicSharingEnabled = false
    expect((await share(clip.id)).status).toBe(403)

    settings.publicSharingEnabled = true

    const response = await share(clip.id)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.url).toMatch(/^http:\/\/localhost\/share\/[a-f0-9]{32}$/)
    expect(database.meetings.get("m_a")?.visibility).toBe("workspace")
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "clip.shared" }))
  })
})
