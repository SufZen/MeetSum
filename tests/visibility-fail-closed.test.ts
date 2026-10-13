/**
 * M9 Step 0 (docs/parity/m9.md item 11, security check 7): a meeting record
 * without `visibility` fails closed on read paths and platform events. The
 * DB column is `not null default 'workspace'`; this is defence in depth.
 * Creation defaults (`input.visibility ?? "workspace"`) are unchanged.
 */
import { describe, expect, it } from "vitest"

import { meetingVisibility, platformEventData } from "@/lib/jobs/processor"
import {
  createInMemoryMeetingDatabase,
  createInMemoryMeetingRepository,
  type MeetingRepository,
  type RepoScope,
} from "@/lib/meetings/repository"
import { canViewMeeting, isWorkspaceVisibleMeeting, memberCanViewMeeting } from "@/lib/meetings/visibility"

import { testMeeting } from "./helpers/route-ctx"

const MEMBER: RepoScope = { kind: "member", workspaceId: "ws_a", userId: "user_other", email: "other@example.com", role: "member" }
const ADMIN: RepoScope = { ...MEMBER, userId: "user_admin", email: "admin@example.com", role: "admin" }
const OWNER: RepoScope = { ...MEMBER, userId: "user_owner", email: "owner@example.com" }

const noVisibility = () => {
  const meeting = testMeeting({ id: "m_nv", ownerUserId: "user_owner", workspaceId: "ws_a" })

  delete (meeting as { visibility?: unknown }).visibility
  return meeting
}

describe("fail-closed meeting visibility (M9)", () => {
  it("canViewMeeting denies non-owners (admins included) when visibility is missing", () => {
    const meeting = noVisibility()

    expect(canViewMeeting(MEMBER, meeting)).toBe(false)
    expect(canViewMeeting(ADMIN, meeting)).toBe(false)
    expect(canViewMeeting(OWNER, meeting)).toBe(true)
    expect(canViewMeeting(MEMBER, meeting, ["other@example.com"])).toBe(true)
    expect(canViewMeeting({ kind: "system", workspaceId: "ws_a" } as RepoScope, meeting)).toBe(true)
    expect(isWorkspaceVisibleMeeting(meeting)).toBe(false)
    expect(memberCanViewMeeting(meeting, { userId: "user_other", email: "other@example.com" })).toBe(false)
  })

  it("the in-memory repository hides it from a non-owner member", async () => {
    const db = createInMemoryMeetingDatabase([noVisibility()])

    expect(await createInMemoryMeetingRepository(db, MEMBER).getMeeting("m_nv")).toBeUndefined()
    expect((await createInMemoryMeetingRepository(db, OWNER).getMeeting("m_nv"))?.id).toBe("m_nv")
  })

  it("a platform event for it carries only the minimal private payload", async () => {
    const repo = { getMeeting: async () => noVisibility() } as unknown as MeetingRepository
    const visibility = await meetingVisibility({ repo }, "m_nv")
    const data = platformEventData("ws_a", { meetingId: "m_nv", title: "Secret board meeting", tags: ["m&a"] }, visibility)

    expect(visibility).toBeUndefined()
    expect(data).toEqual({ meetingId: "m_nv", workspace_id: "ws_a", visibility: "private" })
    expect(JSON.stringify(data)).not.toContain("Secret")
  })

  it("keeps the full payload for workspace meetings", async () => {
    const repo = {
      getMeeting: async () => testMeeting({ id: "m_ws", visibility: "workspace", workspaceId: "ws_a" }),
    } as unknown as MeetingRepository
    const visibility = await meetingVisibility({ repo }, "m_ws")

    expect(visibility).toBe("workspace")
    expect(platformEventData("ws_a", { meetingId: "m_ws", title: "Weekly" }, visibility)).toEqual({
      meetingId: "m_ws",
      title: "Weekly",
    })
  })
})
