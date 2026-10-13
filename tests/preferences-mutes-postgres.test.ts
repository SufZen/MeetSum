/**
 * M9 Integration: notification mutes are one shape end to end. A PATCH body
 * `{ notifications: { muted } }` is parsed by A's preferences module, stored in
 * `users.preferences.notifications.muted` on Postgres, and C's enqueue skips
 * the muted kinds from that column. Runs on PGlite (skipped if it cannot load).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { W1, createM9Database, seedM9Workspaces, type PgLike } from "./helpers/pglite-m9"

const holder = vi.hoisted(() => ({ db: undefined as PgLike | undefined }))

vi.mock("@/lib/db/client", () => ({
  getDatabasePool: () => holder.db,
}))

import type { CollabBackend } from "@/lib/clips/db"
import { enqueueNotification } from "@/lib/notifications/enqueue"
import { getUserPreferences, parsePreferencesPatch, updateUserPreferences } from "@/lib/users/preferences"

beforeAll(async () => {
  holder.db = await createM9Database()
  if (holder.db) await seedM9Workspaces(holder.db)
})

afterAll(async () => {
  await holder.db?.close()
})

describe("notification mutes on Postgres (A preferences -> C enqueue)", () => {
  let backend: CollabBackend

  beforeEach(async (context) => {
    if (!holder.db) {
      context.skip("PGlite did not load")
      return
    }
    vi.stubEnv("MEETSUM_STORAGE", "postgres")
    await holder.db.exec("delete from notifications; update users set preferences = '{}'::jsonb")
    backend = { kind: "postgres", client: holder.db } as CollabBackend
  })

  it("stores the PATCH shape in users.preferences and enqueue honours it", async () => {
    const parsed = parsePreferencesPatch({ notifications: { muted: ["meeting_failed"] } })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    await updateUserPreferences("usr_admin", parsed.patch)

    const stored = await holder.db!.query<{ preferences: unknown }>("select preferences from users where id = 'usr_admin'")

    expect(stored.rows[0]?.preferences).toEqual({ notifications: { muted: ["meeting_failed"] } })
    expect((await getUserPreferences("usr_admin")).notifications.muted).toEqual(["meeting_failed"])

    const muted = await enqueueNotification(
      { workspaceId: W1, userId: "usr_admin", kind: "meeting_failed", payload: { meetingId: "m_x", jobId: "j1" } },
      backend
    )
    const allowed = await enqueueNotification(
      { workspaceId: W1, userId: "usr_admin", kind: "reply", payload: { commentId: "c1" } },
      backend
    )

    expect(muted.skipped).toBe(true)
    expect(allowed.skipped).toBe(false)
  })

  it("concurrent locale and notification PATCHes don't clobber each other", async () => {
    await holder.db!.exec("update users set locale = null, time_zone = null where id = 'usr_admin'")

    await Promise.all([
      updateUserPreferences("usr_admin", { locale: "en" }),
      updateUserPreferences("usr_admin", { notifications: { muted: ["reply"] } }),
      updateUserPreferences("usr_admin", { timeZone: "Europe/Lisbon" }),
    ])

    expect(await getUserPreferences("usr_admin")).toEqual({
      locale: "en",
      timeZone: "Europe/Lisbon",
      notifications: { muted: ["reply"] },
    })
  })

  it("unmuting through the same shape lets the kind through again", async () => {
    await updateUserPreferences("usr_admin", { notifications: { muted: ["meeting_failed"] } })
    await updateUserPreferences("usr_admin", { notifications: { muted: [] } })

    const result = await enqueueNotification(
      { workspaceId: W1, userId: "usr_admin", kind: "meeting_failed", payload: { meetingId: "m_x", jobId: "j2" } },
      backend
    )

    expect(result.skipped).toBe(false)
  })

  it("keeps locale and zone when only mutes change", async () => {
    await updateUserPreferences("usr_admin", { locale: "en", timeZone: "Europe/Lisbon" })
    await updateUserPreferences("usr_admin", { notifications: { muted: ["mention"] } })

    expect(await getUserPreferences("usr_admin")).toEqual({
      locale: "en",
      timeZone: "Europe/Lisbon",
      notifications: { muted: ["mention"] },
    })
  })
})
