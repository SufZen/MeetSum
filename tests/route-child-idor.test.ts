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

const enqueueMeetSumJob = vi.hoisted(() => vi.fn(async () => ({ id: "job_1" })))

vi.mock("@/lib/jobs/queue", () => ({ enqueueMeetSumJob }))

import { PATCH as patchActionItem } from "@/app/api/action-items/[id]/route"
import { POST as approveRun } from "@/app/api/agent-runs/[id]/approve/route"
import { POST as linkContext } from "@/app/api/meetings/[id]/contexts/route"
import { PATCH as patchParticipant } from "@/app/api/meetings/[id]/participants/[participantId]/route"
import { POST as assignSpeaker } from "@/app/api/meetings/[id]/speakers/assign/route"
import type { AuthContext } from "@/lib/auth/authz"
import {
  createInMemoryMeetingDatabase,
  createInMemoryMeetingRepository,
  type InMemoryMeetingDatabase,
  type MeetingRepository,
} from "@/lib/meetings/repository"
import type { WorkspaceRole } from "@/lib/workspaces/types"

const BASE = "http://localhost"

type Fixture = {
  database: InMemoryMeetingDatabase
  w1RunId: string
  w2RunId: string
  w1ParticipantId: string
  w2ParticipantId: string
}

/** Two workspaces, each with a meeting owning action items, runs, participants. */
async function fixture(): Promise<Fixture> {
  const summary = (id: string) => ({
    overview: "o",
    decisions: [],
    actionItems: [{ id, title: `Task ${id}`, status: "open" as const }],
  })
  const database = createInMemoryMeetingDatabase([
    testMeeting({
      id: "m_w1",
      workspaceId: "ws_a",
      participants: ["Dana"],
      summary: summary("ai_w1"),
    }),
    testMeeting({
      id: "m_w2",
      workspaceId: "ws_b",
      participants: ["Avi"],
      summary: summary("ai_w2"),
    }),
  ])
  // Seed each workspace through its own system-scoped repository.
  const w1System = createInMemoryMeetingRepository(database, { kind: "system", workspaceId: "ws_a" })
  const w2System = createInMemoryMeetingRepository(database, { kind: "system", workspaceId: "ws_b" })
  const w1Run = await w1System.createSuggestedAgentRun({
    meetingId: "m_w1",
    target: "n8n",
    payload: {},
  })
  const w2Run = await w2System.createSuggestedAgentRun({
    meetingId: "m_w2",
    target: "n8n",
    payload: {},
  })
  const [w1Participant] = await w1System.listMeetingParticipants("m_w1")
  const [w2Participant] = await w2System.listMeetingParticipants("m_w2")

  return {
    database,
    w1RunId: w1Run.id,
    w2RunId: w2Run.id,
    w1ParticipantId: w1Participant.id,
    w2ParticipantId: w2Participant.id,
  }
}

async function w1Ctx(
  data: Fixture,
  role: WorkspaceRole = "member"
): Promise<AuthContext> {
  const ctx = await createTestCtx({
    role,
    workspaceId: "ws_a",
    database: data.database,
  })

  // Scoped repository behaviour (Package B): only W1 rooms are listed.
  ctx.meetings.listContexts = async () => [
    { id: "ctx_w1", name: "W1 room", createdAt: "2026-10-01T00:00:00Z" },
  ]

  return ctx
}

type Case = {
  name: string
  /** Request a W2-owned child id from W1 (expect 404). */
  foreign: (data: Fixture) => Promise<Response>
  /** Legitimate W1 request (403 for viewers, 2xx for members). */
  own: (data: Fixture) => Promise<Response>
  /** Repository write that must never run for the foreign request. */
  write: keyof MeetingRepository
}

const cases: Case[] = [
  {
    name: "PATCH /api/action-items/:id",
    write: "updateActionItem",
    foreign: () =>
      patchActionItem(
        jsonRequest(`${BASE}/api/action-items/ai_w2`, "PATCH", {
          meetingId: "m_w2",
          status: "done",
        }),
        routeParams({ id: "ai_w2" })
      ),
    own: () =>
      patchActionItem(
        jsonRequest(`${BASE}/api/action-items/ai_w1`, "PATCH", {
          meetingId: "m_w1",
          status: "done",
        }),
        routeParams({ id: "ai_w1" })
      ),
  },
  {
    name: "PATCH /api/action-items/:id (W2 item under a W1 meeting)",
    write: "updateActionItem",
    foreign: () =>
      patchActionItem(
        jsonRequest(`${BASE}/api/action-items/ai_w2`, "PATCH", {
          meetingId: "m_w1",
          status: "done",
        }),
        routeParams({ id: "ai_w2" })
      ),
    own: () =>
      patchActionItem(
        jsonRequest(`${BASE}/api/action-items/ai_w1`, "PATCH", {
          meetingId: "m_w1",
          title: "Renamed",
        }),
        routeParams({ id: "ai_w1" })
      ),
  },
  {
    name: "POST /api/agent-runs/:id/approve",
    write: "approveAgentRun",
    foreign: (data) =>
      approveRun(
        jsonRequest(`${BASE}/api/agent-runs/${data.w2RunId}/approve`, "POST", {
          meetingId: "m_w1",
        }),
        routeParams({ id: data.w2RunId })
      ),
    own: (data) =>
      approveRun(
        jsonRequest(`${BASE}/api/agent-runs/${data.w1RunId}/approve`, "POST", {
          meetingId: "m_w1",
        }),
        routeParams({ id: data.w1RunId })
      ),
  },
  {
    name: "POST /api/agent-runs/:id/approve (W2 meeting id)",
    write: "approveAgentRun",
    foreign: (data) =>
      approveRun(
        jsonRequest(`${BASE}/api/agent-runs/${data.w2RunId}/approve`, "POST", {
          meetingId: "m_w2",
        }),
        routeParams({ id: data.w2RunId })
      ),
    own: (data) =>
      approveRun(
        jsonRequest(`${BASE}/api/agent-runs/${data.w1RunId}/approve`, "POST", {
          meetingId: "m_w1",
        }),
        routeParams({ id: data.w1RunId })
      ),
  },
  {
    name: "PATCH /api/meetings/:id/participants/:participantId",
    write: "updateMeetingParticipant",
    foreign: (data) =>
      patchParticipant(
        jsonRequest(
          `${BASE}/api/meetings/m_w1/participants/${data.w2ParticipantId}`,
          "PATCH",
          { name: "Hijack" }
        ),
        routeParams({ id: "m_w1", participantId: data.w2ParticipantId })
      ),
    own: (data) =>
      patchParticipant(
        jsonRequest(
          `${BASE}/api/meetings/m_w1/participants/${data.w1ParticipantId}`,
          "PATCH",
          { name: "Dana Cohen" }
        ),
        routeParams({ id: "m_w1", participantId: data.w1ParticipantId })
      ),
  },
  {
    name: "POST /api/meetings/:id/speakers/assign",
    write: "updateMeetingSpeaker",
    foreign: (data) =>
      assignSpeaker(
        jsonRequest(`${BASE}/api/meetings/m_w1/speakers/assign`, "POST", {
          speakerLabel: "Speaker 1",
          participantId: data.w2ParticipantId,
        }),
        routeParams({ id: "m_w1" })
      ),
    own: (data) =>
      assignSpeaker(
        jsonRequest(`${BASE}/api/meetings/m_w1/speakers/assign`, "POST", {
          speakerLabel: "Speaker 1",
          participantId: data.w1ParticipantId,
        }),
        routeParams({ id: "m_w1" })
      ),
  },
  {
    name: "POST /api/meetings/:id/contexts",
    write: "linkMeetingContext",
    foreign: () =>
      linkContext(
        jsonRequest(`${BASE}/api/meetings/m_w1/contexts`, "POST", {
          contextId: "ctx_w2",
        }),
        routeParams({ id: "m_w1" })
      ),
    own: () =>
      linkContext(
        jsonRequest(`${BASE}/api/meetings/m_w1/contexts`, "POST", {
          contextId: "ctx_w1",
        }),
        routeParams({ id: "m_w1" })
      ),
  },
]

beforeEach(() => {
  setRouteCtx(undefined)
  enqueueMeetSumJob.mockClear()
})

describe.each(cases)("$name — child-id IDOR", ({ foreign, own, write }) => {
  it("answers 404 for a W2-owned child requested from W1, without writing", async () => {
    const data = await fixture()
    const ctx = await w1Ctx(data)
    const spy = vi.spyOn(ctx.meetings, write as never)
    setRouteCtx(ctx)

    const response = await foreign(data)

    expect(response.status).toBe(404)
    expect(spy).not.toHaveBeenCalled()
  })

  it("answers 403 for a viewer", async () => {
    const data = await fixture()
    const ctx = await w1Ctx(data, "viewer")
    const spy = vi.spyOn(ctx.meetings, write as never)
    setRouteCtx(ctx)

    const response = await own(data)

    expect(response.status).toBe(403)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe("child routes — legitimate W1 requests", () => {
  it("still update action items, runs and participants of visible meetings", async () => {
    const data = await fixture()
    setRouteCtx(await w1Ctx(data))

    const [actionItem, run, participant] = await Promise.all([
      cases[0].own(data),
      cases[2].own(data),
      cases[4].own(data),
    ])

    expect([actionItem.status, run.status, participant.status]).toEqual([
      200, 200, 200,
    ])
  })

  it("requires the parent meetingId for child-only routes", async () => {
    const data = await fixture()
    setRouteCtx(await w1Ctx(data))

    const response = await patchActionItem(
      jsonRequest(`${BASE}/api/action-items/ai_w1`, "PATCH", {
        status: "done",
      }),
      routeParams({ id: "ai_w1" })
    )

    expect(response.status).toBe(400)
  })
})
