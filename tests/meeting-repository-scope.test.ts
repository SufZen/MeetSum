import { beforeEach, describe, expect, it } from "vitest"

import { buildMeetingIntelligence } from "@/lib/intelligence"
import {
  createInMemoryMeetingDatabase,
  createInMemoryMeetingRepository,
  createInMemoryShareLookup,
  type InMemoryMeetingDatabase,
  type MeetingRepository,
  type RepoScope,
} from "@/lib/meetings/repository"

const owner: RepoScope = {
  kind: "member",
  workspaceId: "ws_1",
  userId: "user_owner",
  email: "owner@example.com",
  role: "member",
}
const colleague: RepoScope = {
  kind: "member",
  workspaceId: "ws_1",
  userId: "user_colleague",
  email: "colleague@example.com",
  role: "member",
}
const admin: RepoScope = {
  kind: "member",
  workspaceId: "ws_1",
  userId: "user_admin",
  email: "admin@example.com",
  role: "admin",
}
const participant: RepoScope = {
  kind: "member",
  workspaceId: "ws_1",
  userId: "user_guest",
  email: "Guest@Example.com",
  role: "viewer",
}
const outsider: RepoScope = {
  kind: "member",
  workspaceId: "ws_2",
  userId: "user_w2",
  email: "w2@example.com",
  role: "owner",
}

const meetingInput = {
  title: "Budget review",
  source: "upload" as const,
  language: "en",
  startedAt: "2026-05-01T09:00:00.000Z",
}

let db: InMemoryMeetingDatabase
const repo = (scope: RepoScope): MeetingRepository =>
  createInMemoryMeetingRepository(db, scope)

beforeEach(() => {
  db = createInMemoryMeetingDatabase()
})

describe("in-memory repository workspace isolation", () => {
  it("keeps workspaces apart in lists, search, rooms and direct reads", async () => {
    const w1 = await repo(owner).createMeeting(meetingInput)
    const w2 = await repo(outsider).createMeeting({ ...meetingInput, title: "W2 budget" })

    expect(w1).toMatchObject({ workspaceId: "ws_1", ownerUserId: "user_owner", visibility: "workspace" })
    expect((await repo(colleague).listMeetings()).map((m) => m.id)).toEqual([w1.id])
    expect((await repo(outsider).searchMeetings("budget")).map((m) => m.id)).toEqual([w2.id])
    expect(await repo(colleague).getMeeting(w2.id)).toBeUndefined()
    await expect(repo(colleague).updateMeetingStatus(w2.id, "failed")).rejects.toThrow(
      "Meeting not found"
    )
    expect(await repo({ kind: "system", workspaceId: "ws_2" }).getMeeting(w1.id)).toBeUndefined()
  })

  it("throws not-found for W2 child ids under a W1 scope", async () => {
    const w2Repo = repo(outsider)
    const w2 = await w2Repo.createMeeting({ ...meetingInput, participants: ["dana@example.com"] })

    await w2Repo.upsertMeetingIntelligence(w2.id, {
      ...buildMeetingIntelligence({ ...w2, transcript: [] }),
      actionItems: [
        {
          id: "task_w2",
          title: "Secret task",
          status: "open",
          priority: "normal",
          confidence: 0.9,
          sourceQuote: "x",
          sourceStartMs: 0,
          kind: "explicit",
        },
      ],
    })

    const actionItemId = (await w2Repo.getMeeting(w2.id))!.summary!.actionItems[0].id
    const participantId = (await w2Repo.listMeetingParticipants(w2.id))[0].id
    const run = await w2Repo.createSuggestedAgentRun({ meetingId: w2.id, target: "n8n", payload: {} })
    const job = await w2Repo.createJob({ name: "media.ingest", meetingId: w2.id })
    const w1 = repo(owner)
    const w1Meeting = await w1.createMeeting(meetingInput)

    await expect(w1.updateActionItem(actionItemId, { status: "done" })).rejects.toThrow("not found")
    await expect(w1.updateMeetingParticipant(participantId, { name: "x" })).rejects.toThrow("not found")
    await expect(w1.approveAgentRun(run.id)).rejects.toThrow("not found")
    await expect(w1.updateJob(job.id, { status: "failed" })).rejects.toThrow("not found")
    expect(await w1.getJob(job.id)).toBeUndefined()
    expect(await w1.listJobs()).toEqual([])
    // A W1 meeting paired with a W2 participant is still not found.
    await expect(
      w1.assignSpeakerToParticipant(w1Meeting.id, "A", participantId)
    ).rejects.toThrow("not found")

    // Nothing in W2 changed.
    const after = await w2Repo.getMeeting(w2.id)

    expect(after!.summary!.actionItems[0].status).toBe("open")
    expect((await w2Repo.listMeetingParticipants(w2.id))[0].name).toBe("dana")
  })

  it("scopes contexts and room counts", async () => {
    const context = await repo(outsider).createContext({ name: "W2 room" })
    const meeting = await repo(owner).createMeeting(meetingInput)

    expect(await repo(owner).listContexts()).toEqual([])
    await expect(repo(owner).linkMeetingContext(meeting.id, context.id)).rejects.toThrow(
      "Context not found"
    )
  })
})

describe("in-memory private meetings", () => {
  it("shows private meetings to owner and participants only; admins do not bypass", async () => {
    const meeting = await repo(owner).createMeeting({
      ...meetingInput,
      visibility: "private",
      participants: ["guest@example.com"],
    })

    expect(await repo(owner).getMeeting(meeting.id)).toBeDefined()
    expect(await repo(participant).getMeeting(meeting.id)).toBeDefined()
    expect(await repo(colleague).getMeeting(meeting.id)).toBeUndefined()
    expect(await repo(admin).getMeeting(meeting.id)).toBeUndefined()
    expect(await repo(admin).listMeetings()).toEqual([])
    expect(await repo({ kind: "system", workspaceId: "ws_1" }).getMeeting(meeting.id)).toBeDefined()
  })

  it("lets API keys see private meetings only of the key creator", async () => {
    const meeting = await repo(owner).createMeeting({ ...meetingInput, visibility: "private" })

    expect(
      await repo({ kind: "api_key", workspaceId: "ws_1", ownerUserId: "user_owner" }).getMeeting(meeting.id)
    ).toBeDefined()
    expect(
      await repo({ kind: "api_key", workspaceId: "ws_1", ownerUserId: "user_colleague" }).getMeeting(meeting.id)
    ).toBeUndefined()
    expect(await repo({ kind: "api_key", workspaceId: "ws_1" }).getMeeting(meeting.id)).toBeUndefined()
  })
})

describe("in-memory favorites and shares", () => {
  it("keeps favorites per user and refuses them without a member", async () => {
    const meeting = await repo(owner).createMeeting(meetingInput)

    expect((await repo(owner).updateMeetingFavorite(meeting.id, true)).isFavorite).toBe(true)
    expect((await repo(colleague).getMeeting(meeting.id))!.isFavorite).toBe(false)
    expect((await repo(owner).listMeetings({ status: "favorites" })).map((m) => m.id)).toEqual([
      meeting.id,
    ])
    expect(await repo(colleague).listMeetings({ status: "favorites" })).toEqual([])
    await expect(
      repo({ kind: "api_key", workspaceId: "ws_1" }).updateMeetingFavorite(meeting.id, true)
    ).rejects.toMatchObject({ status: 400 })
  })

  it("sets link on share creation and revokes shares when leaving link", async () => {
    const meeting = await repo(owner).createMeeting(meetingInput)
    const share = await repo(owner).createMeetingShare({ meetingId: meeting.id })
    const lookup = createInMemoryShareLookup(db)

    expect((await repo(owner).getMeeting(meeting.id))!.visibility).toBe("link")
    expect((await lookup.getShareByToken(share.token))?.meeting.workspaceId).toBe("ws_1")

    await repo(owner).updateMeetingVisibility(meeting.id, "workspace")

    expect(await lookup.getShareByToken(share.token)).toBeUndefined()
    expect([...db.shares.values()].every((item) => item.revoked)).toBe(true)
  })

  it("refuses shares of meetings outside the scope", async () => {
    const w2 = await repo(outsider).createMeeting(meetingInput)

    await expect(repo(owner).createMeetingShare({ meetingId: w2.id })).rejects.toThrow(
      "Meeting not found"
    )
    await expect(repo(owner).updateMeetingVisibility(w2.id, "private")).rejects.toThrow(
      "Meeting not found"
    )
  })
})

describe("createMeetingIfAbsent with an invisible external-id holder", () => {
  it("throws a generic conflict for an admin when the holder is private, and dedups when visible", async () => {
    const database = createInMemoryMeetingDatabase()
    const ownerRepo = createInMemoryMeetingRepository(database, owner)
    const adminRepo = createInMemoryMeetingRepository(database, admin)
    const input = {
      title: "Desktop capture",
      source: "desktop_recorder" as const,
      language: "he",
      startedAt: "2026-07-05T09:00:00.000Z",
      externalSource: "desktop_capture",
      externalId: "cap_1",
    }
    const { MeetingExternalIdConflictError } = await import("@/lib/meetings/repository")

    const first = await ownerRepo.createMeetingIfAbsent({
      ...input,
      ownerUserId: "user_owner",
      visibility: "private",
    })

    expect(first.created).toBe(true)
    await expect(adminRepo.createMeetingIfAbsent(input)).rejects.toBeInstanceOf(
      MeetingExternalIdConflictError
    )
    await expect(adminRepo.createMeetingIfAbsent(input)).rejects.not.toThrow(
      /cap_1|desktop_capture/
    )
    await expect(ownerRepo.createMeetingIfAbsent(input)).resolves.toMatchObject({
      created: false,
      meeting: { id: first.meeting.id },
    })
  })
})
