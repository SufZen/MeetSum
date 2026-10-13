/**
 * M9 Integration (docs/parity/m9.md step 3): workspace W1 / W2 plus a
 * meeting private to a W1 member, checked across every M9 surface that reads
 * or links meetings:
 * - analytics: W2 sees only W2; a W1 admin never counts the private meeting;
 * - notifications: rows are per workspace + user, `meeting_processed` for the
 *   private meeting reaches only its owner, and a reader of another workspace
 *   gets nothing;
 * - invitations: only the invitee sees or accepts one, never another
 *   workspace's admin, never by a guessed workspace id;
 * - share: an admin cannot create a link for a member's private meeting and
 *   W2 cannot share a W1 meeting;
 * - offline ingest attach: a W2 caller's `targetMeetingId` of a W1 meeting
 *   (or of the private meeting from another W1 member) is a 404 and stores
 *   nothing.
 * The analytics part runs on PGlite (skipped if it cannot load).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { mockAuthzModule, testAuthContext, testAuthState } from "./helpers/auth-context"
import { streamedMultipartRequest, wavFile } from "./helpers/multipart"
import { USERS, W1, W2, createM9Database, seedM9Analytics, seedM9Workspaces, type PgLike } from "./helpers/pglite-m9"

const storage = vi.hoisted(() => ({ store: vi.fn(), remove: vi.fn() }))

vi.mock("@/lib/auth/authz", async (importOriginal) => mockAuthzModule(importOriginal))
vi.mock("@/lib/storage/object-storage", () => ({
  storeMeetingObjectStream: storage.store,
  deleteMeetingObject: storage.remove,
}))
vi.mock("@/lib/jobs/queue", () => ({ enqueueMeetSumJob: vi.fn(async () => ({ id: "job_1", status: "queued" })) }))
vi.mock("@/lib/users/preferences", () => ({
  getUserPreferences: async () => ({ locale: null, timeZone: null, notifications: { muted: [] } }),
}))

import { getAnalyticsOverview, type AnalyticsRequester } from "@/lib/analytics/dashboard/service"
import { createCollabMemoryDb, type CollabBackend } from "@/lib/clips/db"
import {
  createInMemoryMeetingDatabase,
  createInMemoryMeetingRepository,
  type MeetingRecord,
  type RepoScope,
} from "@/lib/meetings/repository"
import { enqueueNotification } from "@/lib/notifications/enqueue"
import { listMyInvitations } from "@/lib/notifications/invitations"
import { meetingProcessedRecipients } from "@/lib/notifications/producers"
import { listNotificationRows } from "@/lib/notifications/store"
import { acceptInvitationById } from "@/lib/workspaces/invitations"
import { createInMemoryWorkspaceStore } from "@/lib/workspaces/store"

const OCTOBER = {
  from: "2026-09-30T21:00:00.000Z",
  to: "2026-10-31T22:00:00.000Z",
  interval: "month" as const,
  scope: "workspace" as const,
  timeZone: "Asia/Jerusalem",
}

function meeting(id: string, workspaceId: string, ownerUserId: string, visibility: MeetingRecord["visibility"]): MeetingRecord {
  return {
    id,
    title: id === "m_priv" ? "Secret 1:1" : `Meeting ${id}`,
    source: "upload",
    language: "he",
    status: "completed",
    retention: "audio",
    startedAt: "2026-10-15T09:00:00.000Z",
    participants: [],
    workspaceId,
    ownerUserId,
    visibility,
  }
}

const MEETINGS = [
  meeting("m_w1", W1, USERS.owner.id, "workspace"),
  meeting("m_priv", W1, USERS.member.id, "private"),
  meeting("m_w2", W2, USERS.w2.id, "workspace"),
]

function member(user: keyof typeof USERS, workspaceId: string, role: "owner" | "admin" | "member" | "viewer"): RepoScope {
  return { kind: "member", workspaceId, userId: USERS[user].id, email: USERS[user].email, role }
}

describe("M9 isolation: analytics (Postgres)", () => {
  let db: PgLike | undefined

  beforeAll(async () => {
    db = await createM9Database()
    if (!db) return
    await seedM9Workspaces(db)
    await seedM9Analytics(db)
  }, 120_000)

  afterAll(async () => {
    await db?.close()
  })

  const overview = async (who: AnalyticsRequester) => {
    const result = await getAnalyticsOverview(who, OCTOBER, { db: db! })

    if (!result.ok) throw new Error(result.error)
    return result.overview
  }

  it("W2 sees only its own meeting; a W1 admin never counts the private one", async (context) => {
    if (!db) return context.skip("PGlite did not load")

    const w2 = await overview({ workspaceId: W2, userId: USERS.w2.id, email: USERS.w2.email, role: "owner" })
    const admin = await overview({ workspaceId: W1, userId: USERS.admin.id, email: USERS.admin.email, role: "admin" })
    const memberView = await overview({ workspaceId: W1, userId: USERS.member.id, email: USERS.member.email, role: "member" })

    expect(w2.totals.meetings).toBe(1)
    expect(JSON.stringify(w2)).not.toMatch(/Sales sync|Secret|usr_owner|usr_admin|usr_member/)
    expect(admin.totals.meetings).toBe(4)
    expect(JSON.stringify(admin)).not.toContain("Secret")
    expect(memberView.totals.meetings).toBeGreaterThan(admin.totals.meetings - 1)
    // A W2 owner asking for W1 gets W1 nothing (the requester's workspace decides).
    expect(JSON.stringify(w2.talkTime)).not.toContain("usr_")
  })
})

describe("M9 isolation: notifications", () => {
  let backend: CollabBackend

  beforeEach(() => {
    backend = { kind: "memory", db: createCollabMemoryDb() }
  })

  it("meeting_processed for the private meeting reaches only its owner", () => {
    const members = (["owner", "admin", "member", "viewer"] as const).map((user) => ({
      userId: USERS[user].id,
      email: USERS[user].email,
    }))

    // Admins and owners of the workspace get nothing for a member's private meeting.
    expect(meetingProcessedRecipients({ ...MEETINGS[1]!, participantEmails: [] }, members)).toEqual([USERS.member.id])
  })

  it("a reader of another workspace, or another user, gets none of the rows", async () => {
    await enqueueNotification(
      { workspaceId: W1, userId: USERS.member.id, kind: "meeting_processed", payload: { meetingId: "m_priv", transcriptVersion: 1 } },
      backend
    )

    const rows = async (userId: string, workspaceId: string) =>
      (
        await listNotificationRows(
          { userId, workspaceId },
          {},
          backend
        )
      ).rows

    expect(await rows(USERS.member.id, W1)).toHaveLength(1)
    expect(await rows(USERS.member.id, W2)).toHaveLength(0)
    expect(await rows(USERS.admin.id, W1)).toHaveLength(0)
    expect(await rows(USERS.w2.id, W2)).toHaveLength(0)
  })
})

describe("M9 isolation: invitations", () => {
  it("only the invitee lists or accepts it; never another workspace or a guessed workspace id", async () => {
    const store = createInMemoryWorkspaceStore({ seedDefaultWorkspace: false })
    const backend: CollabBackend = { kind: "memory", db: createCollabMemoryDb() }
    const owner = await store.upsertUser({ email: "owner@w1.example", name: "Owner" })
    const otherOwner = await store.upsertUser({ email: "owner@w2.example", name: "W2 owner" })
    const invitee = await store.upsertUser({ email: "invitee@w1.example", name: "Invitee" })
    const w1 = await store.createWorkspace({ name: "W1", createdByUserId: owner.id })
    const w2 = await store.createWorkspace({ name: "W2", createdByUserId: otherOwner.id })
    const { invitation } = await store.createInvitation({
      workspaceId: w1.id,
      email: invitee.email,
      role: "member",
      invitedByUserId: owner.id,
    })

    // The invitee's `invited` notification is how the bell finds it.
    await enqueueNotification(
      {
        workspaceId: w1.id,
        userId: invitee.id,
        kind: "invited",
        payload: { invitationId: invitation.id, workspaceId: w1.id, role: "member" },
      },
      backend
    )

    expect((await listMyInvitations(invitee, store, backend)).map((item) => item.id)).toEqual([invitation.id])
    expect(await listMyInvitations(otherOwner, store, backend)).toEqual([])
    expect((await store.listInvitations(w2.id)).map((item) => item.id)).not.toContain(invitation.id)
    await expect(
      acceptInvitationById(store, { workspaceId: w2.id, invitationId: invitation.id, user: invitee })
    ).rejects.toMatchObject({ code: "not_found" })
    await expect(
      acceptInvitationById(store, { workspaceId: w1.id, invitationId: invitation.id, user: otherOwner })
    ).rejects.toMatchObject({ code: "email_mismatch" })
    expect(await store.getMembership(w1.id, otherOwner.id)).toBeUndefined()
  })
})

describe("M9 isolation: share links", () => {
  it("an admin cannot share a member's private meeting, and W2 cannot share a W1 meeting", async () => {
    const db = createInMemoryMeetingDatabase(MEETINGS)
    const admin = createInMemoryMeetingRepository(db, member("admin", W1, "admin"))
    const w2 = createInMemoryMeetingRepository(db, member("w2", W2, "owner"))
    const owner = createInMemoryMeetingRepository(db, member("member", W1, "member"))

    await expect(admin.createMeetingShare({ meetingId: "m_priv" })).rejects.toThrow()
    await expect(w2.createMeetingShare({ meetingId: "m_w1" })).rejects.toThrow()
    expect(await w2.getMeeting("m_w1")).toBeUndefined()
    expect(await admin.getMeeting("m_priv")).toBeUndefined()
    // Its owner can.
    await expect(owner.createMeetingShare({ meetingId: "m_priv" })).resolves.toMatchObject({ meetingId: "m_priv" })
  })
})

describe("M9 isolation: offline ingest attach", () => {
  const db = createInMemoryMeetingDatabase(MEETINGS)

  beforeEach(() => {
    storage.store.mockReset()
    storage.remove.mockReset()
  })

  async function attach(scope: RepoScope, targetMeetingId: string) {
    testAuthState.ctx = testAuthContext({
      workspaceId: scope.workspaceId,
      role: scope.kind === "member" ? scope.role : "owner",
      meetings: createInMemoryMeetingRepository(db, scope),
    })

    const form = new FormData()

    form.append("meeting", JSON.stringify({ title: "Browser recording", startedAt: "2026-10-15T09:00:00.000Z" }))
    form.append("captureMetadata", JSON.stringify({ captureId: `cap_${targetMeetingId}` }))
    form.append("targetMeetingId", targetMeetingId)
    form.append("file", wavFile())

    const route = await import("@/app/api/desktop-capture/ingest/route")

    return route.POST(await streamedMultipartRequest("http://localhost/api/desktop-capture/ingest", form), {
      params: Promise.resolve({}),
    })
  }

  it.each([
    ["W2 owner → W1 meeting", member("w2", W2, "owner"), "m_w1"],
    ["W2 owner → W1 private meeting", member("w2", W2, "owner"), "m_priv"],
    ["W1 admin → member's private meeting", member("admin", W1, "admin"), "m_priv"],
  ])("%s is a 404 and stores nothing", async (_label, scope, target) => {
    const response = await attach(scope, target)

    expect(response.status).toBe(404)
    expect(storage.store).not.toHaveBeenCalled()
  })
})
