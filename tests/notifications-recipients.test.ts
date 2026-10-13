/**
 * M9 C1 (docs/parity/m9.md) recipients: a private meeting notifies only the
 * members who can see it; non-member participants are excluded; invited goes
 * only to an existing user; bot_blocked to a requester who can see the
 * meeting. Security check 4: recipients pass the visibility rules at enqueue.
 */
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/users/preferences", () => ({
  getUserPreferences: async () => ({ locale: null, timeZone: null, notifications: { muted: [] } }),
}))

import { createCollabMemoryDb, type CollabBackend } from "@/lib/clips/db"
import type { MemoryNotificationRow } from "@/lib/notifications/enqueue"
import {
  meetingProcessedRecipients,
  produceBotBlocked,
  produceInvited,
  produceMeetingFailed,
  produceMeetingProcessed,
  type ProducerDeps,
  type ProducerMeeting,
} from "@/lib/notifications/producers"

const MEMBERS = [
  { userId: "u_owner", email: "owner@w1.example" },
  { userId: "u_part", email: "Part@W1.example" },
  { userId: "u_other", email: "other@w1.example" },
]

function meeting(overrides: Partial<ProducerMeeting> = {}): ProducerMeeting {
  return {
    id: "m1",
    workspaceId: "ws_1",
    ownerUserId: "u_owner",
    visibility: "workspace",
    participantEmails: ["part@w1.example", "outsider@elsewhere.example"],
    ...overrides,
  }
}

function harness(found: ProducerMeeting | undefined, extra: Partial<ProducerDeps> = {}) {
  const db = createCollabMemoryDb()
  const backend: CollabBackend = { kind: "memory", db }
  const deps: ProducerDeps = {
    backend,
    getMeeting: async () => found,
    listMembers: async () => MEMBERS,
    ...extra,
  }

  return { deps, rows: () => db.notifications as MemoryNotificationRow[] }
}

describe("meeting_processed recipients", () => {
  it("are the owner plus participating members, never non-members", () => {
    expect(meetingProcessedRecipients(meeting(), MEMBERS).sort()).toEqual(["u_owner", "u_part"])
  })

  it("of a private meeting are only members who can see it", () => {
    const priv = meeting({ visibility: "private", participantEmails: [] })

    expect(meetingProcessedRecipients(priv, MEMBERS)).toEqual(["u_owner"])
  })

  it("enqueue with the mp dedupe key once per version", async () => {
    const { deps, rows } = harness(meeting())

    await produceMeetingProcessed({ workspaceId: "ws_1", meetingId: "m1", transcriptVersion: 3 }, deps)
    await produceMeetingProcessed({ workspaceId: "ws_1", meetingId: "m1", transcriptVersion: 3 }, deps)

    expect(rows().map((row) => [row.userId, row.dedupeKey]).sort()).toEqual([
      ["u_owner", "mp:m1:3"],
      ["u_part", "mp:m1:3"],
    ])
  })

  it("ignore a meeting of another workspace and never throw", async () => {
    const { deps, rows } = harness(meeting({ workspaceId: "ws_2" }))

    await produceMeetingProcessed({ workspaceId: "ws_1", meetingId: "m1", transcriptVersion: 1 }, deps)
    await expect(
      produceMeetingProcessed(
        { workspaceId: "ws_1", meetingId: "m1", transcriptVersion: 1 },
        { ...deps, getMeeting: async () => Promise.reject(new Error("db down")) }
      )
    ).resolves.toBeUndefined()
    expect(rows()).toHaveLength(0)
  })
})

describe("meeting_failed, invited and bot_blocked recipients", () => {
  it("meeting_failed goes to the owner only", async () => {
    const { deps, rows } = harness(meeting())

    await produceMeetingFailed({ workspaceId: "ws_1", meetingId: "m1", jobId: "job_9" }, deps)

    expect(rows().map((row) => [row.userId, row.dedupeKey])).toEqual([["u_owner", "mf:m1:job_9"]])
  })

  it("invited goes only to an existing user, in the inviting workspace", async () => {
    const pending = { id: "inv_1", workspaceId: "ws_1", email: "New@x.example", role: "member", status: "pending" }
    const existing = harness(undefined, {
      findInvitation: async () => pending,
      getUserIdByEmail: async (email) => (email === "new@x.example" ? "u_new" : undefined),
    })
    const unknown = harness(undefined, {
      findInvitation: async () => pending,
      getUserIdByEmail: async () => undefined,
    })
    const revoked = harness(undefined, {
      findInvitation: async () => ({ ...pending, status: "revoked" }),
      getUserIdByEmail: async () => "u_new",
    })

    await produceInvited({ invitationId: "inv_1" }, existing.deps)
    await produceInvited({ invitationId: "inv_1" }, unknown.deps)
    await produceInvited({ invitationId: "inv_1" }, revoked.deps)

    expect(existing.rows().map((row) => [row.userId, row.workspaceId, row.dedupeKey])).toEqual([
      ["u_new", "ws_1", "inv:inv_1"],
    ])
    expect(unknown.rows()).toHaveLength(0)
    expect(revoked.rows()).toHaveLength(0)
  })

  it("bot_blocked goes to the requester only if they can see the meeting", async () => {
    const visible = harness(meeting(), { getBotRequester: async () => "u_other" })
    const hidden = harness(meeting({ visibility: "private", participantEmails: [] }), {
      getBotRequester: async () => "u_other",
    })

    await produceBotBlocked({ workspaceId: "ws_1", meetingId: "m1", sessionId: "bot_1" }, visible.deps)
    await produceBotBlocked({ workspaceId: "ws_1", meetingId: "m1", sessionId: "bot_1" }, hidden.deps)

    expect(visible.rows().map((row) => [row.userId, row.dedupeKey])).toEqual([["u_other", "bb:bot_1"]])
    expect(hidden.rows()).toHaveLength(0)
  })
})
