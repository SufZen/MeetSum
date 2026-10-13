import { describe, expect, it } from "vitest"

import type { RepoScope } from "@/lib/meetings/repository"
import { canViewMeeting, meetingScopeSql } from "@/lib/meetings/visibility"

const member: RepoScope = {
  kind: "member",
  workspaceId: "ws_a",
  userId: "user_me",
  email: "Me@Example.com",
  role: "member",
}
const admin: RepoScope = { ...member, userId: "user_admin", email: "admin@example.com", role: "admin" }
const apiKey: RepoScope = { kind: "api_key", workspaceId: "ws_a", ownerUserId: "user_me" }
const anonymousKey: RepoScope = { kind: "api_key", workspaceId: "ws_a" }
const system: RepoScope = { kind: "system", workspaceId: "ws_a" }

describe("canViewMeeting", () => {
  it("never shows meetings of another workspace", () => {
    const meeting = { workspaceId: "ws_b", visibility: "workspace" as const }

    for (const scope of [member, admin, apiKey, system]) {
      expect(canViewMeeting(scope, meeting)).toBe(false)
    }
  })

  it("shows workspace and link meetings to every principal of the workspace", () => {
    for (const visibility of ["workspace", "link"] as const) {
      const meeting = { workspaceId: "ws_a", visibility, ownerUserId: "someone" }

      for (const scope of [member, admin, apiKey, anonymousKey, system]) {
        expect(canViewMeeting(scope, meeting)).toBe(true)
      }
    }
  })

  it("defaults missing workspace/visibility to the legacy default workspace", () => {
    expect(canViewMeeting({ ...member, workspaceId: "ws_default" }, {})).toBe(true)
    expect(canViewMeeting(member, {})).toBe(false)
  })

  it("restricts private meetings to owner and participants; admins do not bypass", () => {
    const meeting = { workspaceId: "ws_a", visibility: "private" as const, ownerUserId: "user_me" }

    expect(canViewMeeting(member, meeting)).toBe(true)
    expect(canViewMeeting(admin, meeting)).toBe(false)
    expect(canViewMeeting(admin, meeting, ["other@example.com", null])).toBe(false)
    expect(canViewMeeting(admin, meeting, [" ADMIN@example.com "])).toBe(true)
    expect(canViewMeeting(system, meeting)).toBe(true)
  })

  it("lets API keys see private meetings only when owned by the key creator", () => {
    const mine = { workspaceId: "ws_a", visibility: "private" as const, ownerUserId: "user_me" }
    const theirs = { ...mine, ownerUserId: "user_other" }

    expect(canViewMeeting(apiKey, mine)).toBe(true)
    expect(canViewMeeting(apiKey, theirs)).toBe(false)
    expect(canViewMeeting(anonymousKey, mine)).toBe(false)
    // Participant emails never apply to API keys.
    expect(canViewMeeting(anonymousKey, theirs, ["me@example.com"])).toBe(false)
  })
})

describe("meetingScopeSql", () => {
  it("filters system scope by workspace only", () => {
    const values: unknown[] = ["existing"]

    expect(meetingScopeSql(system, "m", values)).toBe("(m.workspace_id = $2)")
    expect(values).toEqual(["existing", "ws_a"])
  })

  it("adds visibility, owner and participant predicates for members", () => {
    const values: unknown[] = []
    const sql = meetingScopeSql(member, "m", values)

    expect(sql).toContain("m.workspace_id = $1")
    expect(sql).toContain("m.visibility in ('workspace', 'link')")
    expect(sql).toContain("m.owner_user_id = $2")
    expect(sql).toContain("mp_scope.meeting_id = m.id")
    expect(sql).toContain("lower(mp_scope.email) = $3")
    expect(values).toEqual(["ws_a", "user_me", "me@example.com"])
  })

  it("allows owned private meetings for API keys with a creator", () => {
    const values: unknown[] = []
    const sql = meetingScopeSql(apiKey, "meetings", values)

    expect(sql).toContain("meetings.visibility = 'private' and meetings.owner_user_id = $2")
    expect(values).toEqual(["ws_a", "user_me"])

    const anonymousValues: unknown[] = []
    expect(meetingScopeSql(anonymousKey, "m", anonymousValues)).toBe(
      "(m.workspace_id = $1 and m.visibility in ('workspace', 'link'))"
    )
    expect(anonymousValues).toEqual(["ws_a"])
  })

  it("rejects unsafe aliases", () => {
    expect(() => meetingScopeSql(system, "m; drop table meetings", [])).toThrow()
  })
})
