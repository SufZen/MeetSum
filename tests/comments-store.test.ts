import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createCollabMemoryDb, setCollabBackendForTesting, type CollabMemoryDb } from "@/lib/clips/db"
import { createClip } from "@/lib/clips/store"
import {
  CommentError,
  createComment,
  deleteComment,
  editComment,
  listMeetingComments,
  resolveComment,
  toggleReaction,
  type CommentStoreContext,
} from "@/lib/comments/store"
import { normalizeIntelligence } from "@/lib/intelligence/normalize"
import {
  createInMemoryMeetingDatabase,
  createInMemoryMeetingRepository,
  type InMemoryMeetingDatabase,
  type RepoScope,
} from "@/lib/meetings/repository"
import type { WorkspaceRole } from "@/lib/workspaces/types"

import { testMeeting } from "./helpers/route-ctx"

/**
 * M5 C3/C4 comment store: user principal only, target validation against
 * the meeting, one-level threads, plain-text bodies, member-only mentions
 * with notification rows, author/admin/member permissions, orphan flags,
 * tombstones, reactions, and the Postgres visibility scope.
 */

const SEGMENTS = [
  { id: "s1", speaker: "Dana", startMs: 0, endMs: 4000, text: "נתחיל בתקציב" },
  { id: "s2", speaker: "Avi", startMs: 4000, endMs: 9000, text: "התקציב אושר" },
]
const INTELLIGENCE = normalizeIntelligence({
  overview: "",
  items: [{ kind: "decision", text: "התקציב אושר", refs: [] }],
  chapters: [{ id: "ch_1", title: "תקציב", summary: "", startMs: 0, endMs: 9000, startSegmentId: "s1", bullets: [] }],
  actionItems: [{ id: "ai_1", title: "לשלוח סיכום", status: "open", priority: "normal", confidence: 1, sourceQuote: "", sourceStartMs: 0, kind: "explicit" }],
})
const SUMMARY_ITEM = INTELLIGENCE.items?.[0]?.id ?? ""
const MEMBERS = new Set(["user_me", "user_dana", "user_admin", "user_viewer", "user_owner"])

function scope(userId: string, role: WorkspaceRole = "member", workspaceId = "ws_a"): RepoScope {
  return { kind: "member", workspaceId, userId, email: `${userId}@example.com`, role }
}

describe("comment store", () => {
  let collab: CollabMemoryDb
  let db: InMemoryMeetingDatabase

  beforeEach(() => {
    collab = createCollabMemoryDb()
    setCollabBackendForTesting({ kind: "memory", db: collab })
    db = createInMemoryMeetingDatabase([
      testMeeting({ id: "m_a", transcript: SEGMENTS, durationMs: 9000, intelligence: INTELLIGENCE }),
      testMeeting({ id: "m_private", visibility: "private", ownerUserId: "user_owner", transcript: SEGMENTS }),
      testMeeting({ id: "m_b", workspaceId: "ws_b", transcript: SEGMENTS }),
    ])
  })

  afterEach(() => setCollabBackendForTesting(undefined))

  function ctx(userId: string, role: WorkspaceRole = "member", workspaceId = "ws_a"): CommentStoreContext {
    const repoScope = scope(userId, role, workspaceId)

    return {
      scope: repoScope,
      userId,
      meetings: createInMemoryMeetingRepository(db, repoScope),
      listMemberIds: async () => MEMBERS,
    }
  }

  it("validates every target kind against the meeting", async () => {
    const me = ctx("user_me")
    const clip = await createClip({ scope: me.scope, actorUserId: "user_me", meetings: me.meetings }, "m_a", {
      startMs: 0,
      endMs: 4000,
    })

    for (const [targetType, targetId] of [
      ["segment", "s1"],
      ["summary_item", SUMMARY_ITEM],
      ["chapter", "ch_1"],
      ["action_item", "ai_1"],
      ["clip", clip.id],
      ["meeting", "m_a"],
    ] as const) {
      await expect(createComment(me, "m_a", { targetType, targetId, body: "ok" })).resolves.toMatchObject({
        targetType,
        targetId,
      })
    }

    for (const [targetType, targetId] of [
      ["segment", "nope"],
      ["summary_item", "si_000000000000"],
      ["chapter", "ch_x"],
      ["action_item", "ai_x"],
      ["clip", "clip_x"],
      ["meeting", "m_b"],
    ] as const) {
      await expect(createComment(me, "m_a", { targetType, targetId, body: "x" })).rejects.toEqual(
        new CommentError("invalid_target")
      )
    }
  })

  it("stores a time anchor for segment comments", async () => {
    const comment = await createComment(ctx("user_me"), "m_a", { targetType: "segment", targetId: "s2", body: "!" })

    expect(comment.anchor).toEqual({ startMs: 4000, quote: "התקציב אושר" })
  })

  it("requires a member scope matching the user (API keys never comment)", async () => {
    const apiKeyCtx: CommentStoreContext = {
      scope: { kind: "api_key", workspaceId: "ws_a", ownerUserId: "user_me" },
      userId: "user_me",
      meetings: createInMemoryMeetingRepository(db, { kind: "api_key", workspaceId: "ws_a" }),
    }

    await expect(
      createComment(apiKeyCtx, "m_a", { targetType: "segment", targetId: "s1", body: "x" })
    ).rejects.toEqual(new CommentError("user_required"))
    // Reading threads is user-only too.
    await expect(listMeetingComments(apiKeyCtx, "m_a")).rejects.toEqual(new CommentError("user_required"))
  })

  it("treats private and foreign meetings as missing", async () => {
    await expect(
      createComment(ctx("user_me"), "m_private", { targetType: "segment", targetId: "s1", body: "x" })
    ).rejects.toEqual(new CommentError("not_found"))
    await expect(
      createComment(ctx("user_me"), "m_b", { targetType: "segment", targetId: "s1", body: "x" })
    ).rejects.toEqual(new CommentError("not_found"))
    await expect(listMeetingComments(ctx("user_me"), "m_private")).rejects.toEqual(new CommentError("not_found"))
  })

  it("keeps bodies plain text and bounded", async () => {
    const me = ctx("user_me")
    const xss = await createComment(me, "m_a", {
      targetType: "segment",
      targetId: "s1",
      body: "  <img src=x onerror=alert(1)>‮\r\nשורה  ",
    })

    expect(xss.body).toBe("<img src=x onerror=alert(1)>\nשורה")
    await expect(
      createComment(me, "m_a", { targetType: "segment", targetId: "s1", body: "   " })
    ).rejects.toEqual(new CommentError("invalid_body"))
    await expect(
      createComment(me, "m_a", { targetType: "segment", targetId: "s1", body: "א".repeat(4001) })
    ).rejects.toEqual(new CommentError("invalid_body"))
  })

  it("strips non-member mentions and notifies mentioned members and the parent author", async () => {
    const dana = ctx("user_dana")
    const root = await createComment(dana, "m_a", {
      targetType: "summary_item",
      targetId: SUMMARY_ITEM,
      body: "מה דעתך?",
    })
    const reply = await createComment(ctx("user_me"), "m_a", {
      targetType: "summary_item",
      targetId: SUMMARY_ITEM,
      parentId: root.id,
      body: "@[Admin](user:user_admin) @[Eve](user:user_evil) @[me](user:user_me) מסכים",
    })

    expect(reply.body).toBe("@[Admin](user:user_admin) @Eve @[me](user:user_me) מסכים")
    expect(reply.mentions).toEqual(["user_admin", "user_me"])
    expect(collab.notifications.map((n) => [n.userId, n.kind])).toEqual([
      ["user_admin", "mention"],
      ["user_dana", "reply"],
    ])
    expect(collab.notifications[0].payload).toEqual({
      meetingId: "m_a",
      commentId: reply.id,
      targetType: "summary_item",
      targetId: SUMMARY_ITEM,
      parentId: root.id,
      actorUserId: "user_me",
    })
    expect(JSON.stringify(collab.notifications)).not.toContain("מסכים")
  })

  it("threads one level deep on the same target", async () => {
    const me = ctx("user_me")
    const root = await createComment(me, "m_a", { targetType: "segment", targetId: "s1", body: "root" })
    const reply = await createComment(me, "m_a", {
      targetType: "segment",
      targetId: "s1",
      parentId: root.id,
      body: "reply",
    })

    await expect(
      createComment(me, "m_a", { targetType: "segment", targetId: "s1", parentId: reply.id, body: "deep" })
    ).rejects.toEqual(new CommentError("invalid_parent"))
    await expect(
      createComment(me, "m_a", { targetType: "segment", targetId: "s2", parentId: root.id, body: "other" })
    ).rejects.toEqual(new CommentError("invalid_parent"))

    const list = await listMeetingComments(me, "m_a")

    expect(list.threads["segment:s1"]).toHaveLength(1)
    expect(list.threads["segment:s1"][0].replies.map((item) => item.id)).toEqual([reply.id])
  })

  it("lets only the author edit, the author or an admin delete, and members resolve", async () => {
    const root = await createComment(ctx("user_dana"), "m_a", { targetType: "segment", targetId: "s1", body: "a" })

    await expect(editComment(ctx("user_me"), root.id, "b")).rejects.toEqual(new CommentError("forbidden"))
    expect((await editComment(ctx("user_dana"), root.id, "b @[Me](user:user_me)")).editedAt).toBeDefined()
    expect(collab.notifications.at(-1)).toMatchObject({ userId: "user_me", kind: "mention" })

    await expect(resolveComment(ctx("user_viewer", "viewer"), root.id, true)).rejects.toEqual(
      new CommentError("forbidden")
    )
    expect((await resolveComment(ctx("user_me"), root.id, true)).resolvedByUserId).toBe("user_me")
    expect((await resolveComment(ctx("user_me"), root.id, false)).resolvedAt).toBeUndefined()

    await expect(deleteComment(ctx("user_me"), root.id)).rejects.toEqual(new CommentError("forbidden"))
    expect(await deleteComment(ctx("user_admin", "admin"), root.id)).toBe(true)
    await expect(editComment(ctx("user_dana"), root.id, "c")).rejects.toEqual(new CommentError("not_found"))
  })

  it("lists tombstones without bodies and flags orphaned targets", async () => {
    const me = ctx("user_me")
    const root = await createComment(me, "m_a", { targetType: "segment", targetId: "s2", body: "secret words" })

    await createComment(me, "m_a", { targetType: "segment", targetId: "s2", parentId: root.id, body: "reply" })
    await createComment(me, "m_a", { targetType: "chapter", targetId: "ch_1", body: "chapter note" })
    await deleteComment(me, root.id)

    // Regeneration removed the chapter; the transcript lost s2.
    const meeting = db.meetings.get("m_a")

    if (meeting) {
      db.meetings.set("m_a", {
        ...meeting,
        transcript: [SEGMENTS[0]],
        intelligence: { ...INTELLIGENCE, chapters: [] },
      })
    }

    const list = await listMeetingComments(me, "m_a")
    const [tombstone] = list.threads["segment:s2"]

    expect(tombstone.body).toBe("")
    expect(tombstone.deletedAt).toBeDefined()
    expect(tombstone.replies).toHaveLength(1)
    // A tombstone keeps its place only: no quote, author, resolver or edit metadata.
    expect(tombstone.anchor).toEqual({})
    expect(tombstone.authorUserId).toBe("")
    expect(tombstone.resolvedByUserId).toBeUndefined()
    expect(tombstone.editedAt).toBeUndefined()
    expect(list.threads["chapter:ch_1"][0]).toMatchObject({ orphaned: true, anchor: { quote: "תקציב" } })
    expect(JSON.stringify(list)).not.toContain("secret words")
  })

  it("toggles allowlisted reactions and counts them per viewer", async () => {
    const me = ctx("user_me")
    const input = { meetingId: "m_a", targetType: "segment" as const, targetId: "s1", emoji: "\u{1F44D}" as const }

    expect(await toggleReaction(me, input)).toEqual({ active: true })
    expect(await toggleReaction(ctx("user_dana"), input)).toEqual({ active: true })

    let list = await listMeetingComments(me, "m_a")

    expect(list.reactions).toEqual([
      { targetType: "segment", targetId: "s1", emoji: "\u{1F44D}", count: 2, mine: true },
    ])
    expect(await toggleReaction(me, input)).toEqual({ active: false })
    list = await listMeetingComments(me, "m_a")
    expect(list.reactions[0]).toMatchObject({ count: 1, mine: false })

    await expect(toggleReaction(me, { ...input, emoji: "\u{1F4A9}" as never })).rejects.toEqual(
      new CommentError("invalid_emoji")
    )
    await expect(toggleReaction(me, { ...input, targetId: "nope" })).rejects.toEqual(
      new CommentError("invalid_target")
    )
    await expect(toggleReaction(me, { ...input, meetingId: "m_private" })).rejects.toEqual(
      new CommentError("not_found")
    )
  })
})

describe("reaction keys across meetings and workspaces", () => {
  afterEach(() => setCollabBackendForTesting(undefined))

  it("keeps the same summary item in two meetings and two workspaces apart", async () => {
    const collab = createCollabMemoryDb()

    setCollabBackendForTesting({ kind: "memory", db: collab })
    const db = createInMemoryMeetingDatabase([
      testMeeting({ id: "m_1", transcript: SEGMENTS, durationMs: 9000, intelligence: INTELLIGENCE }),
      testMeeting({ id: "m_2", transcript: SEGMENTS, durationMs: 9000, intelligence: INTELLIGENCE }),
      testMeeting({ id: "m_w2", workspaceId: "ws_b", transcript: SEGMENTS, durationMs: 9000, intelligence: INTELLIGENCE }),
    ])
    const ctxFor = (workspaceId: string): CommentStoreContext => {
      const repoScope = scope("user_me", "member", workspaceId)

      return { scope: repoScope, userId: "user_me", meetings: createInMemoryMeetingRepository(db, repoScope) }
    }
    const react = (workspaceId: string, meetingId: string) =>
      toggleReaction(ctxFor(workspaceId), {
        meetingId,
        targetType: "summary_item",
        targetId: SUMMARY_ITEM,
        emoji: "\u{1F44D}",
      })

    // Same hash-derived target id, same user and emoji in three meetings.
    expect(await react("ws_a", "m_1")).toEqual({ active: true })
    expect(await react("ws_a", "m_2")).toEqual({ active: true })
    expect(await react("ws_b", "m_w2")).toEqual({ active: true })
    expect(collab.reactions).toHaveLength(3)
    // Un-reacting in one meeting leaves the others alone.
    expect(await react("ws_a", "m_1")).toEqual({ active: false })
    expect((await listMeetingComments(ctxFor("ws_a"), "m_2")).reactions).toEqual([
      { targetType: "summary_item", targetId: SUMMARY_ITEM, emoji: "\u{1F44D}", count: 1, mine: true },
    ])
    expect((await listMeetingComments(ctxFor("ws_b"), "m_w2")).reactions).toHaveLength(1)
    expect((await listMeetingComments(ctxFor("ws_a"), "m_1")).reactions).toEqual([])
  })

  it("upserts on the workspace + meeting key in SQL", async () => {
    const statements: string[] = []

    setCollabBackendForTesting({
      kind: "postgres",
      client: {
        async query(text: string) {
          statements.push(text)
          return { rows: text.includes("insert into reactions") ? [{ target_id: "s1" }] : [] }
        },
      },
    })
    const db = createInMemoryMeetingDatabase([testMeeting({ id: "m_a", transcript: SEGMENTS })])
    const repoScope = scope("user_me")

    await toggleReaction(
      { scope: repoScope, userId: "user_me", meetings: createInMemoryMeetingRepository(db, repoScope) },
      { meetingId: "m_a", targetType: "segment", targetId: "s1", emoji: "\u{1F44D}" }
    )
    const insert = statements.find((text) => text.includes("insert into reactions"))
    const remove = statements.find((text) => text.includes("delete from reactions"))

    expect(insert).toContain("on conflict (workspace_id, meeting_id, target_type, target_id, user_id, emoji) do nothing")
    expect(remove).toMatch(/meeting_id = \$5 and workspace_id = \$6/)
  })
})

describe("comment store (Postgres SQL)", () => {
  afterEach(() => setCollabBackendForTesting(undefined))

  it("inserts and lists through the meeting visibility scope", async () => {
    const statements: Array<{ text: string; values: unknown[] }> = []

    setCollabBackendForTesting({
      kind: "postgres",
      client: {
        async query(text: string, values: unknown[] = []) {
          statements.push({ text, values })
          if (text.includes("insert into comments")) return { rows: [{ id: "cmt_1", created_at: new Date() }] }
          return { rows: [] }
        },
      },
    })

    const db = createInMemoryMeetingDatabase([testMeeting({ id: "m_a", transcript: SEGMENTS })])
    const repoScope = scope("user_me")
    const ctx: CommentStoreContext = {
      scope: repoScope,
      userId: "user_me",
      meetings: createInMemoryMeetingRepository(db, repoScope),
      listMemberIds: async () => MEMBERS,
    }

    await createComment(ctx, "m_a", { targetType: "segment", targetId: "s1", body: "hi" })
    await listMeetingComments(ctx, "m_a")

    const insert = statements.find((statement) => statement.text.includes("insert into comments"))
    const list = statements.find((statement) => statement.text.includes("from comments c"))
    const reactions = statements.find((statement) => statement.text.includes("from reactions r"))

    expect(insert?.text).toMatch(/where m\.id = \$9 and m\.workspace_id = \$10 and \(m\.workspace_id = \$11/)
    expect(insert?.text).toMatch(/m\.owner_user_id = /)
    expect(list?.text).toMatch(/c\.workspace_id = \$2[\s\S]*m\.visibility in \('workspace', 'link'\)/)
    expect(reactions?.text).toMatch(/r\.workspace_id = \$2[\s\S]*mp_scope/)
  })
})

describe("enqueueNotification", () => {
  it("writes id-only payloads for workspace members and skips self-notifications", async () => {
    const { enqueueNotification } = await import("@/lib/notifications/enqueue")
    const statements: Array<{ text: string; values: unknown[] }> = []
    const backend = {
      kind: "postgres" as const,
      client: {
        async query(text: string, values: unknown[] = []) {
          statements.push({ text, values })
          return { rows: [{ id: "ntf_1" }] }
        },
      },
    }

    const result = await enqueueNotification(
      {
        workspaceId: "ws_a",
        userId: "user_dana",
        kind: "task_assigned",
        payload: { meetingId: "m_a", actionItemId: "ai_1", title: "secret task", body: "x" },
        actorUserId: "user_me",
      },
      backend
    )

    expect(result.skipped).toBe(false)
    expect(statements[0].text).toMatch(
      /where exists \(\s*select 1 from memberships wm where wm\.workspace_id = \$2 and wm\.user_id = \$3/
    )
    expect(JSON.parse(statements[0].values[4] as string)).toEqual({
      meetingId: "m_a",
      actionItemId: "ai_1",
      actorUserId: "user_me",
    })
    expect(
      await enqueueNotification(
        { workspaceId: "ws_a", userId: "user_me", kind: "mention", payload: {}, actorUserId: "user_me" },
        backend
      )
    ).toEqual({ skipped: true })
    expect(statements).toHaveLength(1)
  })
})
