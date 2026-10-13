/**
 * M9 C1 retention: read notifications older than the retention window are
 * deleted; unread and recent rows stay; a dry run deletes nothing (PGlite).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { cleanupReadNotifications, notificationsRetentionDays } from "@/lib/notifications/cleanup"

import { W1, createM9Database, seedM9Workspaces, type PgLike } from "./helpers/pglite-m9"

let db: PgLike | undefined

beforeAll(async () => {
  db = await createM9Database()
  if (!db) return
  await seedM9Workspaces(db)
  await db.exec(`
    insert into notifications (id, workspace_id, user_id, kind, payload, read_at, created_at) values
      ('n_old_read', '${W1}', 'usr_owner', 'reply', '{}', now() - interval '100 days', now() - interval '120 days'),
      ('n_old_unread', '${W1}', 'usr_owner', 'reply', '{}', null, now() - interval '120 days'),
      ('n_recent_read', '${W1}', 'usr_owner', 'reply', '{}', now() - interval '5 days', now() - interval '6 days');
  `)
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe("cleanupReadNotifications", () => {
  it("reads the retention window from the env with a 90-day default", () => {
    expect(notificationsRetentionDays({})).toBe(90)
    expect(notificationsRetentionDays({ MEETSUM_NOTIFICATIONS_RETENTION_DAYS: "30" })).toBe(30)
    expect(notificationsRetentionDays({ MEETSUM_NOTIFICATIONS_RETENTION_DAYS: "-1" })).toBe(90)
  })

  it("dry-runs, then deletes only old read rows", async (context) => {
    if (!db) {
      context.skip("PGlite did not load")
      return
    }

    expect(await cleanupReadNotifications(db, { execute: false, days: 90 })).toEqual({ days: 90, matched: 1, deleted: 0 })
    expect(await cleanupReadNotifications(db, { execute: true, days: 90 })).toEqual({ days: 90, matched: 1, deleted: 1 })

    const left = await db.query<{ id: string }>("select id from notifications order by id")

    expect(left.rows.map((row) => row.id)).toEqual(["n_old_unread", "n_recent_read"])
  })
})
