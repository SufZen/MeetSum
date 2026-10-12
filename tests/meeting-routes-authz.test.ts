import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  createTestCtx,
  jsonRequest,
  routeParams,
  setRouteCtx,
  testMeeting,
} from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

const enqueueMeetSumJob = vi.hoisted(() =>
  vi.fn(async (name: string, payload: Record<string, unknown>) => ({
    id: "job_1",
    name,
    payload,
  }))
)

vi.mock("@/lib/jobs/queue", () => ({ enqueueMeetSumJob }))

import { POST as runAgent } from "@/app/api/agents/run/route"
import { PATCH as patchFavorite } from "@/app/api/meetings/[id]/favorite/route"
import { POST as runIntelligence } from "@/app/api/meetings/[id]/intelligence/run/route"
import { PATCH as patchParticipant } from "@/app/api/meetings/[id]/participants/[participantId]/route"
import { POST as reprocess } from "@/app/api/meetings/[id]/reprocess/route"
import { GET as getMeeting } from "@/app/api/meetings/[id]/route"
import { PATCH as patchTags } from "@/app/api/meetings/[id]/tags/route"
import {
  GET as listMeetings,
  POST as createMeeting,
} from "@/app/api/meetings/route"
import { GET as searchMeetings } from "@/app/api/meetings/search/route"
import { GET as timeline } from "@/app/api/meetings/timeline/route"
import { GET as memorySearch } from "@/app/api/memory/search/route"
import { GET as getRoom } from "@/app/api/rooms/[id]/route"
import { GET as listRooms } from "@/app/api/rooms/route"
import { createInMemoryMeetingRepository } from "@/lib/meetings/repository"
import { updateAppSettings } from "@/lib/settings/app-settings"

const BASE = "http://localhost"

/** Meetings across two workspaces and all visibilities. */
function fixtureMeetings() {
  return [
    testMeeting({
      id: "m_shared",
      title: "Shared roadmap",
      visibility: "workspace",
    }),
    testMeeting({ id: "m_link", title: "Linked roadmap", visibility: "link" }),
    testMeeting({
      id: "m_private_mine",
      title: "My private roadmap",
      visibility: "private",
      ownerUserId: "user_me",
    }),
    testMeeting({
      id: "m_private_other",
      title: "Other private roadmap",
      visibility: "private",
      ownerUserId: "user_owner",
    }),
    testMeeting({
      id: "m_other_ws",
      title: "Other workspace roadmap",
      workspaceId: "ws_b",
      visibility: "workspace",
    }),
  ]
}

beforeEach(() => {
  setRouteCtx(undefined)
  enqueueMeetSumJob.mockClear()
  process.env.MEETSUM_RATE_LIMIT = "false"
})

describe("meeting routes — authentication and permissions", () => {
  it("returns 401 without credentials", async () => {
    const response = await listMeetings(
      new Request(`${BASE}/api/meetings`),
      routeParams({})
    )

    expect(response.status).toBe(401)
  })

  it("forbids viewers from creating meetings (403 with permission)", async () => {
    setRouteCtx(await createTestCtx({ role: "viewer" }))

    const response = await createMeeting(
      jsonRequest(`${BASE}/api/meetings`, "POST", {
        title: "New",
        source: "upload",
        startedAt: "2026-10-01T10:00:00.000Z",
      }),
      routeParams({})
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: "Forbidden",
      permission: "meeting:create",
    })
  })

  it("forbids viewers from mutating meetings", async () => {
    setRouteCtx(
      await createTestCtx({ role: "viewer", meetings: fixtureMeetings() })
    )

    const response = await patchTags(
      jsonRequest(`${BASE}/api/meetings/m_shared/tags`, "PATCH", {
        tags: ["x"],
      }),
      routeParams({ id: "m_shared" })
    )

    expect(response.status).toBe(403)
  })
})

describe("meeting routes — visibility (invisible -> 404)", () => {
  it.each(["m_private_other", "m_other_ws", "missing"])(
    "GET /api/meetings/%s is 404 when not visible",
    async (id) => {
      setRouteCtx(
        await createTestCtx({ role: "admin", meetings: fixtureMeetings() })
      )

      const response = await getMeeting(
        new Request(`${BASE}/api/meetings/${id}`),
        routeParams({ id })
      )

      expect(response.status).toBe(404)
    }
  )

  it("shows the caller's own private meeting", async () => {
    setRouteCtx(await createTestCtx({ meetings: fixtureMeetings() }))

    const response = await getMeeting(
      new Request(`${BASE}/api/meetings/m_private_mine`),
      routeParams({ id: "m_private_mine" })
    )

    expect(response.status).toBe(200)
  })

  it("does not mutate invisible meetings (404 before any write)", async () => {
    const ctx = await createTestCtx({ meetings: fixtureMeetings() })
    const updateTags = vi.spyOn(ctx.meetings, "updateMeetingTags")
    setRouteCtx(ctx)

    const response = await patchTags(
      jsonRequest(`${BASE}/api/meetings/m_other_ws/tags`, "PATCH", {
        tags: ["x"],
      }),
      routeParams({ id: "m_other_ws" })
    )

    expect(response.status).toBe(404)
    expect(updateTags).not.toHaveBeenCalled()
  })

  it("never enqueues jobs for invisible meetings", async () => {
    setRouteCtx(await createTestCtx({ meetings: fixtureMeetings() }))

    const responses = await Promise.all([
      runAgent(
        jsonRequest(`${BASE}/api/agents/run`, "POST", {
          meetingId: "m_private_other",
        }),
        routeParams({})
      ),
      runIntelligence(
        jsonRequest(`${BASE}/api/meetings/m_other_ws/intelligence/run`, "POST"),
        routeParams({ id: "m_other_ws" })
      ),
      reprocess(
        jsonRequest(`${BASE}/api/meetings/m_other_ws/reprocess`, "POST", {
          mode: "summary",
        }),
        routeParams({ id: "m_other_ws" })
      ),
    ])

    expect(responses.map((response) => response.status)).toEqual([
      404, 404, 404,
    ])
    expect(enqueueMeetSumJob).not.toHaveBeenCalled()
  })

  it("tags enqueued jobs with the caller's workspace", async () => {
    setRouteCtx(await createTestCtx({ meetings: fixtureMeetings() }))

    const response = await runIntelligence(
      jsonRequest(`${BASE}/api/meetings/m_shared/intelligence/run`, "POST"),
      routeParams({ id: "m_shared" })
    )

    expect(response.status).toBe(202)
    expect(enqueueMeetSumJob).toHaveBeenCalledWith("meeting.summarize", {
      meetingId: "m_shared",
      workspaceId: "ws_a",
    })
  })
})

describe("meeting lists only contain visible meetings", () => {
  it("search excludes private and other-workspace meetings", async () => {
    setRouteCtx(await createTestCtx({ meetings: fixtureMeetings() }))

    const response = await searchMeetings(
      new Request(`${BASE}/api/meetings/search?q=roadmap`),
      routeParams({})
    )
    const body = await response.json()

    expect(
      body.meetings.map((meeting: { id: string }) => meeting.id).sort()
    ).toEqual(["m_link", "m_private_mine", "m_shared"])
  })

  it("timeline counts only visible meetings", async () => {
    setRouteCtx(await createTestCtx({ meetings: fixtureMeetings() }))

    const response = await timeline(
      new Request(
        `${BASE}/api/meetings/timeline?from=2026-09-01T00:00:00Z&to=2026-11-01T00:00:00Z`
      ),
      routeParams({})
    )
    const body = await response.json()

    expect(body.stats.totalMeetings).toBe(3)
  })

  it("memory search only returns visible meetings", async () => {
    setRouteCtx(await createTestCtx({ meetings: fixtureMeetings() }))

    const response = await memorySearch(
      new Request(`${BASE}/api/memory/search?limit=50`),
      routeParams({})
    )
    const body = await response.json()
    const ids = new Set(
      body.results.map((result: { meetingId: string }) => result.meetingId)
    )

    expect(ids.has("m_private_other")).toBe(false)
    expect(ids.has("m_other_ws")).toBe(false)
  })

  it("rooms are readable by viewers and unknown rooms are 404", async () => {
    setRouteCtx(
      await createTestCtx({ role: "viewer", meetings: fixtureMeetings() })
    )

    expect(
      (await listRooms(new Request(`${BASE}/api/rooms`), routeParams({})))
        .status
    ).toBe(200)
    expect(
      (
        await getRoom(
          new Request(`${BASE}/api/rooms/nope`),
          routeParams({ id: "nope" })
        )
      ).status
    ).toBe(404)
  })
})

describe("POST /api/meetings", () => {
  it("applies the workspace default language, visibility and owner", async () => {
    await updateAppSettings("ws_create", {
      defaultMeetingVisibility: "private",
      meetingLanguageMode: "en",
    })
    const repository = createInMemoryMeetingRepository([])
    const create = vi.spyOn(repository, "createMeeting")
    setRouteCtx(
      await createTestCtx({
        workspaceId: "ws_create",
        repository,
        userId: "user_creator",
      })
    )

    const response = await createMeeting(
      jsonRequest(`${BASE}/api/meetings`, "POST", {
        title: "Planning",
        source: "upload",
        startedAt: "2026-10-01T10:00:00.000Z",
      }),
      routeParams({})
    )

    expect(response.status).toBe(201)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Planning",
        language: "en",
        ownerUserId: "user_creator",
        visibility: "private",
      })
    )
  })

  it("keeps an explicit language", async () => {
    await updateAppSettings("ws_create2", { meetingLanguageMode: "en" })
    const repository = createInMemoryMeetingRepository([])
    const create = vi.spyOn(repository, "createMeeting")
    setRouteCtx(await createTestCtx({ workspaceId: "ws_create2", repository }))

    await createMeeting(
      jsonRequest(`${BASE}/api/meetings`, "POST", {
        title: "Planning",
        source: "upload",
        language: "pt",
        startedAt: "2026-10-01T10:00:00.000Z",
      }),
      routeParams({})
    )

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ language: "pt", visibility: "workspace" })
    )
  })
})

describe("PATCH /api/meetings/:id/favorite", () => {
  it("rejects API keys (favorites are per user)", async () => {
    setRouteCtx(
      await createTestCtx({
        principal: "api_key",
        role: "viewer",
        meetings: fixtureMeetings(),
      })
    )

    const response = await patchFavorite(
      jsonRequest(`${BASE}/api/meetings/m_shared/favorite`, "PATCH", {
        favorite: true,
      }),
      routeParams({ id: "m_shared" })
    )

    expect(response.status).toBe(400)
  })

  it("lets viewers favorite visible meetings and 404s invisible ones", async () => {
    setRouteCtx(
      await createTestCtx({ role: "viewer", meetings: fixtureMeetings() })
    )

    const ok = await patchFavorite(
      jsonRequest(`${BASE}/api/meetings/m_shared/favorite`, "PATCH", {
        favorite: true,
      }),
      routeParams({ id: "m_shared" })
    )
    const hidden = await patchFavorite(
      jsonRequest(`${BASE}/api/meetings/m_private_other/favorite`, "PATCH", {
        favorite: true,
      }),
      routeParams({ id: "m_private_other" })
    )

    expect(ok.status).toBe(200)
    expect(hidden.status).toBe(404)
  })
})

describe("PATCH /api/meetings/:id/participants/:participantId", () => {
  it("404s a participant that belongs to another meeting", async () => {
    const meetings = [
      testMeeting({ id: "m_one", participants: ["Dana"] }),
      testMeeting({ id: "m_two", participants: ["Avi"] }),
    ]
    const ctx = await createTestCtx({ meetings })
    const [foreign] = await ctx.meetings.listMeetingParticipants("m_two")
    const update = vi.spyOn(ctx.meetings, "updateMeetingParticipant")
    setRouteCtx(ctx)

    const response = await patchParticipant(
      jsonRequest(
        `${BASE}/api/meetings/m_one/participants/${foreign.id}`,
        "PATCH",
        {
          name: "Hijack",
        }
      ),
      routeParams({ id: "m_one", participantId: foreign.id })
    )

    expect(response.status).toBe(404)
    expect(update).not.toHaveBeenCalled()
  })

  it("requires manage rights to change a participant email on a private meeting", async () => {
    const meetings = [
      testMeeting({
        id: "m_priv",
        visibility: "private",
        ownerUserId: "user_owner",
        participants: ["Me"],
      }),
    ]
    const repository = createInMemoryMeetingRepository(meetings)
    const [me] = await repository.listMeetingParticipants("m_priv")
    await repository.updateMeetingParticipant(me.id, {
      email: "me@example.com",
    })
    const ctx = await createTestCtx({ repository })
    setRouteCtx(ctx)

    const response = await patchParticipant(
      jsonRequest(
        `${BASE}/api/meetings/m_priv/participants/${me.id}`,
        "PATCH",
        {
          email: "friend@example.com",
        }
      ),
      routeParams({ id: "m_priv", participantId: me.id })
    )

    expect(response.status).toBe(403)
  })
})
