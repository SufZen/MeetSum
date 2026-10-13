import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { Queryable } from "@/lib/db/client"
import { createPostgresMeetingRepository, createPostgresShareLookup } from "@/lib/meetings/postgres-repository"
import type { MeetingRepository } from "@/lib/meetings/repository"
import { createShareAccessCookie, verifyShareAccessCookie } from "@/lib/sharing/share-access"
import { verifySharePassword } from "@/lib/sharing/share-password"
import { createM8Database, seedM8Workspaces, type PgLike } from "@/tests/helpers/pglite-m8"

/**
 * M9 B4 on real SQL (PGlite with migrations 001–030): the share password is
 * persisted as scrypt in meeting_shares.password_hash, cleared, scoped to the
 * workspace, and a change invalidates outstanding access cookies.
 */

const SECRET = "share-password-postgres-secret"

let db: PgLike | undefined
let repo: MeetingRepository
let otherWorkspace: MeetingRepository

beforeAll(async () => {
  db = await createM8Database()

  if (!db) return

  await seedM8Workspaces(db)
  repo = createPostgresMeetingRepository(db as unknown as Queryable, { kind: "system", workspaceId: "ws_1" })
  otherWorkspace = createPostgresMeetingRepository(db as unknown as Queryable, { kind: "system", workspaceId: "ws_2" })
}, 60_000)

afterAll(async () => {
  await db?.close()
})

async function sharedMeeting() {
  const meeting = await repo.createMeeting({
    title: "פגישה מוגנת",
    startedAt: "2026-10-13T08:00:00.000Z",
    source: "upload",
    language: "he",
    participants: [],
  })

  return repo.createMeetingShare({ meetingId: meeting.id })
}

describe("share passwords on Postgres", () => {
  it("persists a scrypt hash, verifies it, and clears it", async (context) => {
    if (!db) return context.skip()

    const share = await sharedMeeting()

    expect(share.passwordHash).toBeUndefined()

    const updated = await repo.updateMeetingSharePassword(share.id, "correct-horse-1")
    const row = (await db.query("select password_hash from meeting_shares where id = $1", [share.id])).rows[0] as {
      password_hash: string
    }

    expect(updated.passwordHash).toBe(row.password_hash)
    expect(row.password_hash).toMatch(/^scrypt\$32768\$8\$1\$/)
    expect(await verifySharePassword("correct-horse-1", row.password_hash)).toBe(true)

    const lookup = await createPostgresShareLookup(db as unknown as Queryable).getShareByToken(share.token)

    expect(lookup?.share.passwordHash).toBe(row.password_hash)

    const cleared = await repo.updateMeetingSharePassword(share.id, null)
    const after = (await db.query("select password_hash from meeting_shares where id = $1", [share.id])).rows[0] as {
      password_hash: string | null
    }

    expect(cleared.passwordHash).toBeUndefined()
    expect(after.password_hash).toBeNull()
  })

  it("stores a password given at creation", async (context) => {
    if (!db) return context.skip()

    const meeting = await repo.createMeeting({
      title: "Created protected",
      startedAt: "2026-10-13T08:00:00.000Z",
      source: "upload",
      language: "en",
      participants: [],
    })
    const share = await repo.createMeetingShare({ meetingId: meeting.id, password: "created-with-pass" })

    expect(await verifySharePassword("created-with-pass", share.passwordHash)).toBe(true)
  })

  it("invalidates access cookies when the password changes or is cleared", async (context) => {
    if (!db) return context.skip()

    const share = await sharedMeeting()
    const first = await repo.updateMeetingSharePassword(share.id, "first-password")
    const cookie = createShareAccessCookie({ token: share.token, passwordHash: first.passwordHash!, secret: SECRET })

    expect(verifyShareAccessCookie(cookie.value, { token: share.token, passwordHash: first.passwordHash!, secret: SECRET })).toBe(true)

    const second = await repo.updateMeetingSharePassword(share.id, "second-password")

    expect(verifyShareAccessCookie(cookie.value, { token: share.token, passwordHash: second.passwordHash!, secret: SECRET })).toBe(false)
    expect(await verifySharePassword("first-password", second.passwordHash)).toBe(false)
  })

  it("never touches another workspace's share", async (context) => {
    if (!db) return context.skip()

    const share = await sharedMeeting()

    await expect(otherWorkspace.updateMeetingSharePassword(share.id, "intruder-pass")).rejects.toThrow(/Share not found/)

    const row = (await db.query("select password_hash from meeting_shares where id = $1", [share.id])).rows[0] as {
      password_hash: string | null
    }

    expect(row.password_hash).toBeNull()
  })
})
