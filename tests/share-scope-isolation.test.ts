import { describe, expect, it } from "vitest"

import {
  createInMemoryMeetingDatabase,
  createInMemoryMeetingRepository,
  createInMemoryShareLookup,
  isMeetingScopeShare,
  type InMemoryMeetingDatabase,
  type MeetingShare,
} from "@/lib/meetings/repository"

/**
 * M5 share isolation (docs/parity/m5.md B5): a clip-scope token never
 * resolves as a meeting share and never makes the meeting link-visible.
 * The Postgres side is asserted in postgres-workspace-scope.test.ts.
 */

const NOW = "2026-10-15T09:00:00.000Z"

function seed(visibility: "workspace" | "link" = "workspace") {
  const db = createInMemoryMeetingDatabase([
    {
      id: "meet_1",
      title: "Sync",
      source: "upload",
      language: "he",
      status: "completed",
      retention: "audio",
      startedAt: NOW,
      participants: [],
      workspaceId: "ws_a",
      ownerUserId: "user_me",
      visibility,
    },
  ])

  return db
}

function addClipShare(db: InMemoryMeetingDatabase, token = "clip_tok"): MeetingShare {
  const share: MeetingShare = {
    id: "share_clip",
    meetingId: "meet_1",
    token,
    visibility: "public",
    revoked: false,
    includedSections: [],
    createdAt: NOW,
    updatedAt: NOW,
    scope: "clip",
    clipId: "clip_1",
  }

  db.shares.set(share.id, share)
  return share
}

const system = { kind: "system", workspaceId: "ws_a" } as const

describe("clip share isolation", () => {
  it("never resolves a clip token as a meeting share", async () => {
    const db = seed("link")

    addClipShare(db)

    const repository = createInMemoryMeetingRepository(db, system)
    const lookup = createInMemoryShareLookup(db)

    expect(await repository.getShareByToken("clip_tok")).toBeUndefined()
    expect(await lookup.getShareByToken("clip_tok")).toBeUndefined()
    expect(await lookup.getShareMediaByToken("clip_tok")).toBeUndefined()
  })

  it("does not make the meeting link-visible or count as its share link", async () => {
    const db = seed("workspace")

    addClipShare(db)

    const repository = createInMemoryMeetingRepository(db, system)

    expect(await repository.getShareByToken("clip_tok")).toBeUndefined()
    expect(db.meetings.get("meet_1")?.visibility).toBe("workspace")

    // Creating the meeting link mints a new meeting-scope share.
    const meetingShare = await repository.createMeetingShare({ meetingId: "meet_1" })

    expect(meetingShare.token).not.toBe("clip_tok")
    expect(isMeetingScopeShare(meetingShare)).toBe(true)
    expect((await repository.getShareByToken(meetingShare.token))?.share.id).toBe(meetingShare.id)
  })

  it("leaving link revokes meeting shares only; going private revokes clip shares too", async () => {
    const db = seed("workspace")
    const repository = createInMemoryMeetingRepository(db, system)
    const meetingShare = await repository.createMeetingShare({ meetingId: "meet_1" })

    addClipShare(db)
    await repository.updateMeetingVisibility("meet_1", "workspace")

    expect(db.shares.get(meetingShare.id)?.revoked).toBe(true)
    expect(db.shares.get("share_clip")?.revoked).toBe(false)

    await repository.updateMeetingVisibility("meet_1", "private")
    expect(db.shares.get("share_clip")?.revoked).toBe(true)
  })

  it("treats legacy shares without a scope as meeting shares", () => {
    expect(isMeetingScopeShare({})).toBe(true)
    expect(isMeetingScopeShare({ scope: "meeting" })).toBe(true)
    expect(isMeetingScopeShare({ scope: "clip" })).toBe(false)
  })
})
