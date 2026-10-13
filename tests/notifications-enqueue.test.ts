/**
 * M9 C1 (docs/parity/m9.md): enqueueNotification never notifies the actor,
 * respects mutes, dedupes, caps unread rows and writes meeting/actor links.
 * Memory backend always; the Postgres part runs on PGlite (skipped if it
 * cannot load).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const getUserPreferences = vi.hoisted(() =>
  vi.fn(async (userId: string) => ({
    locale: null,
    timeZone: null,
    notifications: { muted: userId === "usr_muted" ? ["mention"] : [] },
  }))
)

vi.mock("@/lib/users/preferences", () => ({ getUserPreferences }))

import { createCollabMemoryDb, type CollabBackend } from "@/lib/clips/db"
import {
  MAX_UNREAD_PER_USER,
  defaultDedupeKey,
  enqueueNotification,
  type MemoryNotificationRow,
} from "@/lib/notifications/enqueue"

import { W1, W2, createM9Database, seedM9Analytics, seedM9Workspaces, type PgLike } from "./helpers/pglite-m9"

function memory(): { backend: CollabBackend; rows: () => MemoryNotificationRow[] } {
  const db = createCollabMemoryDb()

  return { backend: { kind: "memory", db }, rows: () => db.notifications as MemoryNotificationRow[] }
}

describe("enqueueNotification (memory)", () => {
  it("never notifies the actor, including M5 assignedByUserId", async () => {
    const { backend, rows } = memory()

    expect(
      await enqueueNotification(
        { workspaceId: "ws", userId: "u1", kind: "mention", payload: { commentId: "c1" }, actorUserId: "u1" },
        backend
      )
    ).toEqual({ skipped: true })
    expect(
      await enqueueNotification(
        { workspaceId: "ws", userId: "u1", kind: "task_assigned", payload: { actionItemId: "a1", assignedByUserId: "u1" } },
        backend
      )
    ).toEqual({ skipped: true })
    expect(rows()).toHaveLength(0)
  })

  it("respects muted kinds", async () => {
    const { backend, rows } = memory()

    await enqueueNotification({ workspaceId: "ws", userId: "usr_muted", kind: "mention", payload: { commentId: "c1" } }, backend)
    await enqueueNotification({ workspaceId: "ws", userId: "usr_muted", kind: "reply", payload: { commentId: "c2" } }, backend)

    expect(rows().map((row) => row.kind)).toEqual(["reply"])
  })

  it("dedupes per user and key, and stores ids only", async () => {
    const { backend, rows } = memory()
    const input = {
      workspaceId: "ws",
      userId: "u1",
      kind: "meeting_processed" as const,
      payload: { meetingId: "m1", transcriptVersion: 2, title: "Secret title", summary: "x" },
    }

    expect((await enqueueNotification(input, backend)).skipped).toBe(false)
    expect((await enqueueNotification(input, backend)).skipped).toBe(true)
    expect((await enqueueNotification({ ...input, userId: "u2" }, backend)).skipped).toBe(false)

    const [first] = rows()

    expect(first?.dedupeKey).toBe("mp:m1:2")
    expect(first?.meetingId).toBe("m1")
    expect(first?.payload).toEqual({ meetingId: "m1", transcriptVersion: 2 })
    expect(JSON.stringify(rows())).not.toContain("Secret title")
  })

  it("marks the oldest unread beyond the cap as read", async () => {
    const { backend, rows } = memory()

    for (let index = 0; index < MAX_UNREAD_PER_USER + 3; index += 1) {
      await enqueueNotification(
        { workspaceId: "ws", userId: "u1", kind: "reply", payload: { commentId: `c${index}` } },
        backend
      )
    }

    expect(rows().filter((row) => !row.readAt)).toHaveLength(MAX_UNREAD_PER_USER)
  })

  it("derives dedupe keys per kind", () => {
    const now = new Date("2026-10-13T10:00:00Z")

    expect(defaultDedupeKey("mention", { commentId: "c" }, now)).toBe("mn:c")
    expect(defaultDedupeKey("reply", { commentId: "c" }, now)).toBe("rp:c")
    expect(defaultDedupeKey("task_assigned", { actionItemId: "a" }, now)).toBe("ta:a:2026-10-13")
    expect(defaultDedupeKey("integration_reauth", { connectionId: "k" }, now)).toBe("ir:k:2026-10-13")
    expect(defaultDedupeKey("meeting_failed", { meetingId: "m", jobId: "j" }, now)).toBe("mf:m:j")
    expect(defaultDedupeKey("invited", { invitationId: "i" }, now)).toBe("inv:i")
    expect(defaultDedupeKey("bot_blocked", { sessionId: "s" }, now)).toBe("bb:s")
  })
})

let db: PgLike | undefined

beforeAll(async () => {
  db = await createM9Database()
  if (db) {
    await seedM9Workspaces(db)
    await seedM9Analytics(db)
  }
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe("enqueueNotification (Postgres on PGlite)", () => {
  let backend: CollabBackend

  beforeEach(async (context) => {
    if (!db) {
      context.skip("PGlite did not load")
      return
    }
    await db.exec("delete from notifications")
    backend = { kind: "postgres", client: db }
  })

  it("writes meeting and actor links and dedupes on (user, key)", async () => {
    const input = {
      workspaceId: W1,
      userId: "usr_owner",
      kind: "mention" as const,
      payload: { meetingId: "m_a1", commentId: "cmt_1" },
      actorUserId: "usr_admin",
    }

    expect((await enqueueNotification(input, backend)).skipped).toBe(false)
    expect((await enqueueNotification(input, backend)).skipped).toBe(true)

    const rows = await db!.query("select meeting_id, actor_user_id, dedupe_key from notifications")

    expect(rows.rows).toEqual([{ meeting_id: "m_a1", actor_user_id: "usr_admin", dedupe_key: "mn:cmt_1" }])
  })

  it("refuses non-members (except invited) and a meeting of another workspace", async () => {
    expect(
      (await enqueueNotification({ workspaceId: W1, userId: "usr_w2", kind: "reply", payload: { commentId: "c" } }, backend))
        .skipped
    ).toBe(true)
    expect(
      (
        await enqueueNotification(
          { workspaceId: W1, userId: "usr_w2", kind: "invited", payload: { invitationId: "inv_1", workspaceId: W1 } },
          backend
        )
      ).skipped
    ).toBe(false)

    await enqueueNotification(
      { workspaceId: W1, userId: "usr_owner", kind: "meeting_processed", payload: { meetingId: "m_w2", transcriptVersion: 1 } },
      backend
    )

    const rows = await db!.query<{ meeting_id: string | null }>(
      "select meeting_id from notifications where user_id = 'usr_owner'"
    )

    expect(rows.rows).toEqual([{ meeting_id: null }])
  })

  it("skips kinds muted in users.preferences", async () => {
    await db!.query(
      `update users set preferences = '{"notifications":{"muted":["meeting_failed"]}}'::jsonb where id = 'usr_admin'`
    )

    const muted = await enqueueNotification(
      { workspaceId: W1, userId: "usr_admin", kind: "meeting_failed", payload: { meetingId: "m_a2", jobId: "j1" } },
      backend
    )
    const allowed = await enqueueNotification(
      { workspaceId: W1, userId: "usr_admin", kind: "meeting_processed", payload: { meetingId: "m_a2", transcriptVersion: 1 } },
      backend
    )

    expect(muted.skipped).toBe(true)
    expect(allowed.skipped).toBe(false)
    await db!.query(`update users set preferences = '{}'::jsonb where id = 'usr_admin'`)
  })

  it("keeps at most the cap unread", async () => {
    await db!.exec(`
      insert into notifications (id, workspace_id, user_id, kind, payload, created_at)
      select 'ntf_seed_' || g, '${W2}', 'usr_w2', 'reply', '{}'::jsonb, now() - (g || ' minutes')::interval
      from generate_series(1, ${MAX_UNREAD_PER_USER}) g
    `)

    await enqueueNotification({ workspaceId: W2, userId: "usr_w2", kind: "reply", payload: { commentId: "new" } }, backend)

    const unread = await db!.query<{ n: number }>(
      "select count(*)::int as n from notifications where user_id = 'usr_w2' and read_at is null"
    )
    const oldest = await db!.query<{ read_at: unknown }>(
      `select read_at from notifications where id = 'ntf_seed_${MAX_UNREAD_PER_USER}'`
    )

    expect(unread.rows[0]?.n).toBe(MAX_UNREAD_PER_USER)
    expect(oldest.rows[0]?.read_at).not.toBeNull()
  })
})
