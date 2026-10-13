import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createCollabMemoryDb, setCollabBackendForTesting, type CollabMemoryDb } from "@/lib/clips/db"
import { ClipValidationError, resolveClipRange } from "@/lib/clips/range"
import { chapterHeadings, nextSelection, selectionRange } from "@/lib/clips/selection"
import {
  ClipNotFoundError,
  createClip,
  deleteClip,
  getClip,
  listClips,
  renameClip,
  type ClipStoreContext,
} from "@/lib/clips/store"
import {
  createInMemoryMeetingDatabase,
  createInMemoryMeetingRepository,
  type InMemoryMeetingDatabase,
  type RepoScope,
  type TranscriptSegment,
} from "@/lib/meetings/repository"

import { testMeeting } from "./helpers/route-ctx"

/**
 * M5 C1 clip data layer: range validation (segments → min/max, 2 s ≤ range ≤
 * MEETSUM_CLIP_MAX_MS, inside the meeting), excerpt/title derivation, the
 * memory backend's visibility gate, and the Postgres SQL scope.
 */

const SEGMENTS: TranscriptSegment[] = [
  { id: "s1", speaker: "Dana", startMs: 0, endMs: 4000, text: "שלום לכולם, נתחיל בעדכון" },
  { id: "s2", speaker: "Avi", startMs: 4000, endMs: 9000, text: "התקציב אושר אתמול" },
  { id: "s3", speaker: "Dana", startMs: 9000, endMs: 15000, text: "מעולה, אז ה-API יעלה ביום ראשון" },
]

const member = (userId: string, email: string, workspaceId = "ws_a"): RepoScope => ({
  kind: "member",
  workspaceId,
  userId,
  email,
  role: "member",
})

function seed(): InMemoryMeetingDatabase {
  return createInMemoryMeetingDatabase([
    testMeeting({ id: "m_a", transcript: SEGMENTS, durationMs: 15_000 }),
    testMeeting({
      id: "m_private",
      visibility: "private",
      ownerUserId: "user_owner",
      transcript: SEGMENTS,
      durationMs: 15_000,
    }),
    testMeeting({ id: "m_b", workspaceId: "ws_b", transcript: SEGMENTS, durationMs: 15_000 }),
  ])
}

function ctxFor(db: InMemoryMeetingDatabase, scope: RepoScope): ClipStoreContext {
  return {
    scope,
    actorUserId: scope.kind === "member" ? scope.userId : undefined,
    meetings: createInMemoryMeetingRepository(db, scope),
  }
}

describe("resolveClipRange", () => {
  const context = { segments: SEGMENTS, durationMs: 15_000 }

  it("turns selected segments into their min start / max end", () => {
    const range = resolveClipRange({ segmentIds: ["s3", "s2"] }, context)

    expect(range).toMatchObject({ startMs: 4000, endMs: 15_000, segmentIds: ["s2", "s3"] })
    expect(range.transcriptExcerpt).toBe("התקציב אושר אתמול מעולה, אז ה-API יעלה ביום ראשון")
  })

  it("keeps an explicit range and collects the overlapping segments", () => {
    const range = resolveClipRange({ startMs: 3500, endMs: 6000, title: "  Budget\nupdate " }, context)

    expect(range).toMatchObject({ startMs: 3500, endMs: 6000, segmentIds: ["s1", "s2"] })
    expect(range.title).toBe("Budget update")
  })

  it("defaults the title to the first 60 characters of the excerpt", () => {
    const long = [{ id: "x", startMs: 0, endMs: 5000, text: "א".repeat(80) }]
    const range = resolveClipRange({ startMs: 0, endMs: 5000 }, { segments: long, durationMs: 5000 })

    expect(Array.from(range.title)).toHaveLength(60)
    expect(range.title.endsWith("…")).toBe(true)
  })

  it("truncates the excerpt to 1000 characters", () => {
    const long = [{ id: "x", startMs: 0, endMs: 5000, text: "word ".repeat(400) }]
    const range = resolveClipRange({ startMs: 0, endMs: 5000 }, { segments: long, durationMs: 5000 })

    expect(Array.from(range.transcriptExcerpt ?? "").length).toBeLessThanOrEqual(1000)
  })

  it.each([
    [{ startMs: 1000, endMs: 2500 }, "too_short"],
    [{ startMs: 5000, endMs: 5000 }, "invalid_range"],
    [{ startMs: 6000, endMs: 5000 }, "invalid_range"],
    [{ startMs: -5, endMs: 5000 }, "invalid_range"],
    [{ startMs: 0, endMs: 20_000 }, "out_of_bounds"],
    [{ segmentIds: ["nope"] }, "unknown_segment"],
    [{ segmentIds: [] }, "unknown_segment"],
  ])("rejects %j with %s", (input, code) => {
    expect(() => resolveClipRange(input, context)).toThrow(
      expect.objectContaining({ code }) as ClipValidationError
    )
  })

  it("rejects ranges longer than MEETSUM_CLIP_MAX_MS", () => {
    expect(() =>
      resolveClipRange({ startMs: 0, endMs: 12_000 }, { ...context, maxMs: 10_000 })
    ).toThrow(expect.objectContaining({ code: "too_long" }) as ClipValidationError)
  })

  it("rejects a meeting without transcript or duration", () => {
    expect(() => resolveClipRange({ startMs: 0, endMs: 5000 }, { segments: [] })).toThrow(
      expect.objectContaining({ code: "out_of_bounds" }) as ClipValidationError
    )
  })
})

describe("transcript selection helpers", () => {
  it("selects single rows and shift-click ranges", () => {
    let selection: { ids: Set<string>; anchor?: number } = { ids: new Set() }

    selection = nextSelection(selection, SEGMENTS, 0, false)
    expect([...selection.ids]).toEqual(["s1"])
    selection = nextSelection(selection, SEGMENTS, 2, true)
    expect([...selection.ids]).toEqual(["s1", "s2", "s3"])
    expect(selectionRange(selection.ids, SEGMENTS)).toEqual({
      startMs: 0,
      endMs: 15_000,
      segmentIds: ["s1", "s2", "s3"],
    })
    selection = nextSelection({ ids: new Set(["s2"]), anchor: 1 }, SEGMENTS, 1, false)
    expect(selection.ids.size).toBe(0)
    expect(selection.anchor).toBeUndefined()
  })

  it("puts chapter headings only on real segments", () => {
    const chapters = [
      { id: "ch1", title: "פתיחה", summary: "", startMs: 0, endMs: 9000, startSegmentId: "s1", bullets: [] },
      { id: "ch2", title: "API", summary: "", startMs: 8000, endMs: 15_000, startSegmentId: "gone", bullets: [] },
      { id: "ch3", title: "late", summary: "", startMs: 99_000, endMs: 99_500, startSegmentId: "gone", bullets: [] },
    ]
    const headings = chapterHeadings(chapters, SEGMENTS)

    expect(headings.get("s1")?.id).toBe("ch1")
    expect(headings.get("s3")?.id).toBe("ch2")
    expect([...headings.values()].map((chapter) => chapter.id)).not.toContain("ch3")
  })
})

describe("clip store (memory backend)", () => {
  let collab: CollabMemoryDb
  let db: InMemoryMeetingDatabase

  beforeEach(() => {
    collab = createCollabMemoryDb()
    setCollabBackendForTesting({ kind: "memory", db: collab })
    db = seed()
  })

  afterEach(() => setCollabBackendForTesting(undefined))

  it("creates a pending clip from segments and lists it", async () => {
    const ctx = ctxFor(db, member("user_me", "me@example.com"))
    const clip = await createClip(ctx, "m_a", { segmentIds: ["s2"] })

    expect(clip).toMatchObject({
      workspaceId: "ws_a",
      meetingId: "m_a",
      startMs: 4000,
      endMs: 9000,
      renderStatus: "pending",
      createdByUserId: "user_me",
      title: "התקציב אושר אתמול",
    })
    expect(clip.storageKey).toBeUndefined()
    expect((await listClips(ctx, "m_a"))?.map((item) => item.id)).toEqual([clip.id])
  })

  it("treats invisible and foreign meetings as missing (404)", async () => {
    const outsider = ctxFor(db, member("user_me", "me@example.com"))

    await expect(createClip(outsider, "m_private", { startMs: 0, endMs: 5000 })).rejects.toBeInstanceOf(
      ClipNotFoundError
    )
    await expect(createClip(outsider, "m_b", { startMs: 0, endMs: 5000 })).rejects.toBeInstanceOf(
      ClipNotFoundError
    )
    expect(await listClips(outsider, "m_private")).toBeUndefined()

    const owner = ctxFor(db, member("user_owner", "owner@example.com"))
    const clip = await createClip(owner, "m_private", { startMs: 0, endMs: 5000 })

    expect(await getClip(outsider, clip.id)).toBeUndefined()
    expect(await getClip(owner, clip.id)).toBeDefined()

    const otherWorkspace = ctxFor(db, member("user_owner", "owner@example.com", "ws_b"))

    expect(await getClip(otherWorkspace, clip.id)).toBeUndefined()
  })

  it("renames and soft-deletes", async () => {
    const ctx = ctxFor(db, member("user_me", "me@example.com"))
    const clip = await createClip(ctx, "m_a", { startMs: 0, endMs: 5000 })

    expect((await renameClip(ctx, clip.id, "Kickoff")).title).toBe("Kickoff")
    expect(await deleteClip(ctx, clip.id)).toBe(true)
    expect(await getClip(ctx, clip.id)).toBeUndefined()
    expect(await listClips(ctx, "m_a")).toEqual([])
    expect(await deleteClip(ctx, clip.id)).toBe(false)
    expect(collab.clips.get(clip.id)?.deletedAt).toBeDefined()
  })
})

describe("clip store (Postgres SQL)", () => {
  type Statement = { text: string; values: unknown[] }

  afterEach(() => setCollabBackendForTesting(undefined))

  function recording(rows: Record<string, unknown[]> = {}) {
    const statements: Statement[] = []

    return {
      statements,
      client: {
        async query(text: string, values: unknown[] = []) {
          statements.push({ text, values })
          const key = Object.keys(rows).find((pattern) => text.includes(pattern))

          return { rows: key ? rows[key] : [] }
        },
      },
    }
  }

  const clipRow = {
    id: "clip_1",
    workspace_id: "ws_a",
    meeting_id: "m_a",
    title: "t",
    start_ms: 0,
    end_ms: 5000,
    segment_ids: ["s1"],
    transcript_excerpt: null,
    render_status: "pending",
    storage_key: null,
    render_error: null,
    created_by_user_id: "user_me",
    created_at: new Date("2026-10-01T10:00:00Z"),
    updated_at: new Date("2026-10-01T10:00:00Z"),
  }

  it("inserts through a visibility-scoped select of the meeting", async () => {
    const pool = recording({ "insert into meeting_clips": [clipRow] })

    setCollabBackendForTesting({ kind: "postgres", client: pool.client })

    const scope = member("user_me", "me@example.com")
    const clip = await createClip(ctxFor(seed(), scope), "m_a", { startMs: 0, endMs: 5000 })
    const insert = pool.statements.find((statement) => statement.text.includes("insert into meeting_clips"))

    expect(clip.id).toBe("clip_1")
    expect(insert?.text).toMatch(/from meetings m\s+where m\.id = \$8 and \(m\.workspace_id = \$9/)
    expect(insert?.text).toMatch(/m\.owner_user_id = \$10/)
    expect(insert?.text).toMatch(/lower\(mp_scope\.email\) = \$11/)
    expect(insert?.values.slice(7)).toEqual(["m_a", "ws_a", "user_me", "me@example.com"])
  })

  it("lists live clips of the workspace with the meeting scope", async () => {
    const pool = recording({ "from meeting_clips c": [clipRow] })

    setCollabBackendForTesting({ kind: "postgres", client: pool.client })

    const clips = await listClips(ctxFor(seed(), member("user_me", "me@example.com")), "m_a")
    const select = pool.statements[0]

    expect(clips).toHaveLength(1)
    expect(select.text).toMatch(/c\.deleted_at is null/)
    expect(select.text).toMatch(/c\.workspace_id = m\.workspace_id/)
    expect(select.text).toMatch(/m\.visibility in \('workspace', 'link'\)/)
    expect(select.values.slice(0, 2)).toEqual(["m_a", "ws_a"])
  })

  it("soft-deletes with the scope and revokes the clip's shares", async () => {
    const pool = recording({ "from meeting_clips c": [clipRow], "update meeting_clips c set deleted_at": [{ id: "clip_1" }] })

    setCollabBackendForTesting({ kind: "postgres", client: pool.client })

    expect(await deleteClip(ctxFor(seed(), member("user_me", "me@example.com")), "clip_1")).toBe(true)

    const texts = pool.statements.map((statement) => statement.text)

    expect(texts.some((text) => /update meeting_clips c set deleted_at = now\(\)[\s\S]*m\.visibility in/.test(text))).toBe(true)
    expect(texts.some((text) => /update meeting_shares set revoked = true[\s\S]*scope = 'clip'/.test(text))).toBe(true)
  })
})
