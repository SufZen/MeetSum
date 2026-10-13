import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  authorizeShareMediaRequest: vi.fn(),
  headMeetingObject: vi.fn(),
  getMeetingObjectRange: vi.fn(),
}))

vi.mock("@/lib/sharing/share-media-access", () => ({
  authorizeShareMediaRequest: mocks.authorizeShareMediaRequest,
}))
vi.mock("@/lib/storage/object-storage", () => ({
  headMeetingObject: mocks.headMeetingObject,
  getMeetingObjectRange: mocks.getMeetingObjectRange,
}))
// The media route uses the store's default meeting loader and settings.
vi.mock("@/lib/meetings/store", () => ({
  getSystemMeetingRepository: () => ({
    getMeeting: async () => ({
      id: "m_a",
      title: "Weekly",
      startedAt: "2026-10-01T10:00:00.000Z",
      language: "en",
      visibility: "workspace",
      workspaceId: "ws_a",
    }),
  }),
}))
vi.mock("@/lib/settings/app-settings", () => ({
  getAppSettings: async () => ({ publicSharingEnabled: true }),
}))

import { GET, HEAD } from "@/app/api/share/[token]/media/route"
import { createCollabMemoryDb, setCollabBackendForTesting, type CollabMemoryDb } from "@/lib/clips/db"
import { buildClipSharePayload } from "@/lib/clips/share-payload"
import {
  ClipShareError,
  createClip,
  createClipShare,
  deleteClip,
  lookupClipShare,
  setClipRenderResult,
  type ClipShareLookupDeps,
  type ClipStoreContext,
} from "@/lib/clips/store"
import {
  createInMemoryMeetingDatabase,
  createInMemoryMeetingRepository,
  type InMemoryMeetingDatabase,
  type RepoScope,
} from "@/lib/meetings/repository"

import { testMeeting } from "./helpers/route-ctx"

/**
 * M5 C2 clip shares: `scope='clip'` rows that never change meeting
 * visibility, 409 for private meetings, a token gate that fails closed
 * (revoked / expired / deleted / private / sharing off), a clip-only
 * payload and a media route that serves only the clip object — and leaves
 * the M4 meeting-share path untouched.
 */

const OWNER: RepoScope = {
  kind: "member",
  workspaceId: "ws_a",
  userId: "user_owner",
  email: "owner@example.com",
  role: "member",
}

const SEGMENTS = [
  { id: "s1", speaker: "Dana", startMs: 0, endMs: 5000, text: "שלום, זה הקטע לשיתוף" },
  { id: "s2", speaker: "Avi", startMs: 5000, endMs: 9000, text: "סוד פנימי שלא ישותף" },
]

describe("clip shares", () => {
  let collab: CollabMemoryDb
  let db: InMemoryMeetingDatabase
  let ctx: ClipStoreContext
  let sharingEnabled: boolean
  let lookupDeps: ClipShareLookupDeps

  beforeEach(() => {
    collab = createCollabMemoryDb()
    setCollabBackendForTesting({ kind: "memory", db: collab })
    db = createInMemoryMeetingDatabase([
      testMeeting({
        id: "m_a",
        title: "עדכון שבועי",
        ownerUserId: "user_owner",
        transcript: SEGMENTS,
        durationMs: 9000,
        participantDetails: [],
      }),
      testMeeting({
        id: "m_private",
        visibility: "private",
        ownerUserId: "user_owner",
        transcript: SEGMENTS,
        durationMs: 9000,
      }),
    ])
    ctx = { scope: OWNER, actorUserId: "user_owner", meetings: createInMemoryMeetingRepository(db, OWNER) }
    sharingEnabled = true
    lookupDeps = {
      loadMeeting: async (workspaceId, meetingId) => {
        const meeting = await createInMemoryMeetingRepository(db, { kind: "system", workspaceId }).getMeeting(
          meetingId
        )

        return meeting
          ? {
              title: meeting.title,
              startedAt: meeting.startedAt,
              language: meeting.language,
              visibility: meeting.visibility,
              workspaceId: meeting.workspaceId,
            }
          : undefined
      },
      publicSharingEnabled: async () => sharingEnabled,
    }
  })

  afterEach(() => setCollabBackendForTesting(undefined))

  it("creates one active clip-scope share without touching meeting visibility", async () => {
    const clip = await createClip(ctx, "m_a", { segmentIds: ["s1"] })
    const share = await createClipShare(ctx, clip.id)
    const again = await createClipShare(ctx, clip.id)

    expect(share.token).toMatch(/^[a-f0-9]{32}$/)
    expect(share.includedSections).toEqual([])
    expect(again.token).toBe(share.token)
    expect(db.meetings.get("m_a")?.visibility).toBe("workspace")
    expect(db.shares.size).toBe(0)
  })

  it("rejects sharing a clip of a private meeting", async () => {
    const clip = await createClip(ctx, "m_private", { segmentIds: ["s1"] })

    await expect(createClipShare(ctx, clip.id)).rejects.toEqual(new ClipShareError("meeting_private"))
  })

  it("resolves an active token to the clip and minimal meeting facts only", async () => {
    const clip = await createClip(ctx, "m_a", { segmentIds: ["s1"] })
    const share = await createClipShare(ctx, clip.id)
    const result = await lookupClipShare(share.token, lookupDeps)

    expect(result.kind).toBe("clip")
    if (result.kind !== "clip") return
    expect(result.view.meeting).toEqual({
      title: "עדכון שבועי",
      startedAt: "2026-10-01T10:00:00.000Z",
      language: "he",
    })

    const payload = buildClipSharePayload(result.view)
    const json = JSON.stringify(payload)

    expect(payload).toMatchObject({ lang: "he", dir: "rtl", textDir: "rtl", audioReady: false })
    expect(payload.excerpt).toBe("שלום, זה הקטע לשיתוף")
    for (const secret of [clip.id, "m_a", "ws_a", "user_owner", "s1", "clips/", "@", "סוד פנימי"]) {
      expect(json).not.toContain(secret)
    }
  })

  it.each([
    ["revoked", async (token: string) => {
      for (const share of collab.clipShares.values()) {
        if (share.token === token) collab.clipShares.set(share.id, { ...share, revoked: true })
      }
    }],
    ["expired", async (token: string) => {
      for (const share of collab.clipShares.values()) {
        if (share.token === token) {
          collab.clipShares.set(share.id, { ...share, expiresAt: "2020-01-01T00:00:00.000Z" })
        }
      }
    }],
    ["clip deleted", async () => {
      const [stored] = collab.clips.values()

      await deleteClip(ctx, stored.id)
    }],
    ["meeting made private", async () => {
      const meeting = db.meetings.get("m_a")

      if (meeting) db.meetings.set("m_a", { ...meeting, visibility: "private" })
    }],
    ["public sharing disabled", async () => {
      sharingEnabled = false
    }],
  ])("fails closed when %s", async (_label, mutate) => {
    const clip = await createClip(ctx, "m_a", { segmentIds: ["s1"] })
    const share = await createClipShare(ctx, clip.id)

    await mutate(share.token)

    expect(await lookupClipShare(share.token, lookupDeps)).toEqual({ kind: "clip_unavailable" })
  })

  it("reports unknown tokens as not a clip", async () => {
    expect(await lookupClipShare("0123456789abcdef", lookupDeps)).toEqual({ kind: "not_clip" })
    expect(await lookupClipShare("../etc", lookupDeps)).toEqual({ kind: "not_clip" })
  })

  it("only ever resolves scope='clip' rows on Postgres", async () => {
    const statements: string[] = []

    setCollabBackendForTesting({
      kind: "postgres",
      client: {
        async query(text: string) {
          statements.push(text)
          return { rows: [] }
        },
      },
    })

    expect(await lookupClipShare("0123456789abcdef")).toEqual({ kind: "not_clip" })
    expect(statements[0]).toMatch(/where s\.token = \$1 and s\.scope = 'clip'/)
    expect(statements[0]).toMatch(/join meeting_clips c on c\.id = s\.clip_id/)
  })

  it("inserts Postgres clip shares only for non-private, visible meetings", async () => {
    const statements: Array<{ text: string; values: unknown[] }> = []
    const clipRow = {
      id: "clip_1",
      workspace_id: "ws_a",
      meeting_id: "m_a",
      title: "t",
      start_ms: 0,
      end_ms: 5000,
      segment_ids: [],
      transcript_excerpt: null,
      render_status: "pending",
      storage_key: null,
      render_error: null,
      created_by_user_id: "user_owner",
      created_at: "2026-10-01T10:00:00.000Z",
      updated_at: "2026-10-01T10:00:00.000Z",
    }

    setCollabBackendForTesting({
      kind: "postgres",
      client: {
        async query(text: string, values: unknown[] = []) {
          statements.push({ text, values })
          if (text.includes("insert into meeting_shares")) {
            return {
              rows: [
                {
                  id: "share_1",
                  meeting_id: "m_a",
                  token: "t".repeat(32),
                  revoked: false,
                  expires_at: null,
                  created_by: "user_owner",
                  created_at: "2026-10-01T10:00:00.000Z",
                  updated_at: "2026-10-01T10:00:00.000Z",
                },
              ],
            }
          }
          return { rows: text.includes("from meeting_clips c") && !text.includes("meeting_shares") ? [clipRow] : [] }
        },
      },
    })

    const share = await createClipShare(ctx, "clip_1")
    const insert = statements.find((statement) => statement.text.includes("insert into meeting_shares"))

    expect(share.id).toBe("share_1")
    expect(insert?.text).toMatch(/'\[\]'::jsonb, \$3, 'clip', c\.id/)
    expect(insert?.text).toMatch(/m\.visibility <> 'private'/)
    expect(insert?.text).toMatch(/c\.deleted_at is null/)
    expect(insert?.text).toMatch(/m\.owner_user_id = /)
  })
})

describe("GET /api/share/:token/media (clip tokens)", () => {
  const CLIP_TOKEN = "c".repeat(32)
  const MEETING_TOKEN = "m".repeat(32)
  let collab: CollabMemoryDb

  beforeEach(() => {
    vi.clearAllMocks()
    collab = createCollabMemoryDb()
    setCollabBackendForTesting({ kind: "memory", db: collab })
    mocks.headMeetingObject.mockResolvedValue({ sizeBytes: 9 })
    mocks.getMeetingObjectRange.mockImplementation(async () => ({
      body: new Blob([new Uint8Array(9)]).stream(),
      contentLength: 9,
    }))
    mocks.authorizeShareMediaRequest.mockResolvedValue(undefined)
  })

  afterEach(() => setCollabBackendForTesting(undefined))

  const params = (token: string) => ({ params: Promise.resolve({ token }) })

  async function seedClip(options: { ready?: boolean; revoked?: boolean } = {}) {
    collab.clips.set("clip_1", {
      id: "clip_1",
      workspaceId: "ws_a",
      meetingId: "m_a",
      title: "t",
      startMs: 0,
      endMs: 5000,
      segmentIds: [],
      renderStatus: options.ready === false ? "pending" : "ready",
      ...(options.ready === false ? {} : { storageKey: "clips/ws_a/clip_1.m4a" }),
      createdAt: "2026-10-01T10:00:00.000Z",
      updatedAt: "2026-10-01T10:00:00.000Z",
    })
    collab.clipShares.set("share_1", {
      id: "share_1",
      meetingId: "m_a",
      clipId: "clip_1",
      token: CLIP_TOKEN,
      revoked: options.revoked ?? false,
      createdAt: "2026-10-01T10:00:00.000Z",
      updatedAt: "2026-10-01T10:00:00.000Z",
    })
  }

  it("proxies only the clip object (no presign) and never consults the meeting share", async () => {
    await seedClip()

    const response = await GET(new Request(`http://localhost/api/share/${CLIP_TOKEN}/media`), params(CLIP_TOKEN))

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("audio/mp4")
    expect(response.headers.get("etag")).not.toContain("clip_1")
    expect(mocks.headMeetingObject).toHaveBeenCalledWith("clips/ws_a/clip_1.m4a")
    expect(mocks.getMeetingObjectRange).toHaveBeenCalledWith("clips/ws_a/clip_1.m4a", expect.anything())
    expect(mocks.authorizeShareMediaRequest).not.toHaveBeenCalled()

    const head = await HEAD(
      new Request(`http://localhost/api/share/${CLIP_TOKEN}/media`, { method: "HEAD" }),
      params(CLIP_TOKEN)
    )

    expect(head.status).toBe(200)
  })

  it("404s a revoked clip token without falling through to the meeting recording", async () => {
    await seedClip({ revoked: true })

    const response = await GET(new Request(`http://localhost/api/share/${CLIP_TOKEN}/media`), params(CLIP_TOKEN))

    expect(response.status).toBe(404)
    expect(mocks.authorizeShareMediaRequest).not.toHaveBeenCalled()
    expect(mocks.getMeetingObjectRange).not.toHaveBeenCalled()
  })

  it("404s a clip whose audio is not rendered yet", async () => {
    await seedClip({ ready: false })

    const response = await GET(new Request(`http://localhost/api/share/${CLIP_TOKEN}/media`), params(CLIP_TOKEN))

    expect(response.status).toBe(404)
  })

  it("leaves meeting tokens on the M4 gate (404 when it refuses)", async () => {
    const response = await GET(
      new Request(`http://localhost/api/share/${MEETING_TOKEN}/media`),
      params(MEETING_TOKEN)
    )

    expect(response.status).toBe(404)
    expect(mocks.authorizeShareMediaRequest).toHaveBeenCalledWith(expect.any(Request), MEETING_TOKEN)
    expect(mocks.getMeetingObjectRange).not.toHaveBeenCalled()
  })

  it("never serves a non-canonical storage key", async () => {
    await seedClip()
    await setClipRenderResult("ws_a", "clip_1", {
      status: "ready",
      storageKey: "meetings/ws_a/m_a/original.mp3",
    })

    const response = await GET(new Request(`http://localhost/api/share/${CLIP_TOKEN}/media`), params(CLIP_TOKEN))

    expect(response.status).toBe(404)
    expect(mocks.getMeetingObjectRange).not.toHaveBeenCalled()
  })
})
