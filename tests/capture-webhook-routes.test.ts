import { createHmac } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { mockAuthzModule, testAuthContext, testAuthState } from "./helpers/auth-context"

const mocks = vi.hoisted(() => ({
  createMeetingIfAbsent: vi.fn(),
  discardMeeting: vi.fn(),
  enqueueMeetSumJob: vi.fn(),
  recordAuditLog: vi.fn(),
  handleTeamsLifecycleNotifications: vi.fn(),
  repositoryWorkspaces: [] as string[],
}))

vi.mock("@/lib/api/responses", async () => {
  const { NextResponse } = await import("next/server")

  return {
    requireAppAccess: vi.fn(async () => undefined),
    jsonError: (message: string, status = 400) =>
      NextResponse.json({ error: message }, { status }),
  }
})

vi.mock("@/lib/meetings/store", () => ({
  getSystemMeetingRepository: (workspaceId: string) => {
    mocks.repositoryWorkspaces.push(workspaceId)
    return {
      createMeetingIfAbsent: mocks.createMeetingIfAbsent,
      discardMeeting: mocks.discardMeeting,
    }
  },
}))

vi.mock("@/lib/auth/authz", async (importOriginal) => mockAuthzModule(importOriginal))

vi.mock("@/lib/jobs/queue", () => ({
  enqueueMeetSumJob: mocks.enqueueMeetSumJob,
}))

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}))

vi.mock("@/lib/capture/teams-subscriptions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/capture/teams-subscriptions")>()),
  handleTeamsLifecycleNotifications: mocks.handleTeamsLifecycleNotifications,
}))

type RouteHandler = (
  request: Request,
  route: { params: Promise<Record<string, string>> }
) => Promise<Response>

const noParams = { params: Promise.resolve({}) }
const bind = (handler: RouteHandler) => (request: Request) => handler(request, noParams)

const ZOOM_SECRET = "zoom-secret"
const CLIENT_STATE = "teams-state"

const zoomEvent = {
  event: "recording.completed",
  payload: {
    object: {
      uuid: "zoom-uuid==",
      id: 123,
      topic: "Weekly",
      start_time: "2026-05-29T10:00:00Z",
      duration: 30,
      recording_files: [
        {
          id: "f1",
          file_type: "M4A",
          recording_type: "audio_only",
          status: "completed",
          download_url: "https://zoom.us/rec/download/audio",
        },
      ],
    },
  },
}

function zoomRequest(body: unknown, sign = true, secret = ZOOM_SECRET) {
  const raw = JSON.stringify(body)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const headers: Record<string, string> = { "content-type": "application/json" }

  if (sign) {
    headers["x-zm-request-timestamp"] = timestamp
    headers["x-zm-signature"] = `v0=${createHmac("sha256", secret)
      .update(`v0:${timestamp}:${raw}`)
      .digest("hex")}`
  }

  return new Request("http://localhost/api/webhooks/zoom", {
    method: "POST",
    body: raw,
    headers,
  })
}

function teamsNotification(id: string, overrides: Record<string, unknown> = {}) {
  return {
    subscriptionId: "sub-1",
    changeType: "created",
    resource: `communications/onlineMeetings('m1')/recordings('${id}')`,
    clientState: CLIENT_STATE,
    resourceData: { id },
    ...overrides,
  }
}

function teamsRequest(body: unknown, path = "/api/webhooks/teams") {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("ZOOM_WEBHOOK_SECRET", ZOOM_SECRET)
  vi.stubEnv("TEAMS_WEBHOOK_CLIENT_STATE", CLIENT_STATE)
  mocks.createMeetingIfAbsent.mockImplementation(
    async (input: { externalSource: string; externalId: string }) => ({
      meeting: { id: `meet_${input.externalSource}_${input.externalId}` },
      created: true,
    })
  )
  mocks.discardMeeting.mockResolvedValue(true)
  mocks.enqueueMeetSumJob.mockResolvedValue({ id: "job_1" })
  mocks.recordAuditLog.mockResolvedValue(undefined)
  mocks.repositoryWorkspaces.length = 0
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("zoom webhook route", () => {
  it("returns 503 for the URL challenge when no secret is configured", async () => {
    vi.stubEnv("ZOOM_WEBHOOK_SECRET", "")
    const POST = bind((await import("@/app/api/webhooks/zoom/route")).POST)
    const response = await POST(
      zoomRequest({ event: "endpoint.url_validation", payload: { plainToken: "pt" } }, false)
    )

    expect(response.status).toBe(503)
  })

  it("answers a signed challenge and rejects a badly signed one", async () => {
    const POST = bind((await import("@/app/api/webhooks/zoom/route")).POST)
    const challenge = { event: "endpoint.url_validation", payload: { plainToken: "pt" } }

    const ok = await POST(zoomRequest(challenge))
    expect(ok.status).toBe(200)
    await expect(ok.json()).resolves.toEqual({
      plainToken: "pt",
      encryptedToken: createHmac("sha256", ZOOM_SECRET).update("pt").digest("hex"),
    })

    const forged = await POST(zoomRequest(challenge, true, "wrong-secret"))
    expect(forged.status).toBe(401)
  })

  it("refuses unsigned challenges so the endpoint is not a signing oracle", async () => {
    const POST = bind((await import("@/app/api/webhooks/zoom/route")).POST)
    // An attacker would use plainToken = "v0:<ts>:<forged body>" to mint a
    // valid event signature from the challenge response.
    const response = await POST(
      zoomRequest(
        { event: "endpoint.url_validation", payload: { plainToken: "v0:1:{}" } },
        false
      )
    )

    expect(response.status).toBe(401)
  })

  it("rejects unsigned recording events", async () => {
    const POST = bind((await import("@/app/api/webhooks/zoom/route")).POST)
    const response = await POST(zoomRequest(zoomEvent, false))

    expect(response.status).toBe(401)
    expect(mocks.createMeetingIfAbsent).not.toHaveBeenCalled()
  })

  it("creates the meeting idempotently and enqueues media.ingest with the capture event", async () => {
    const POST = bind((await import("@/app/api/webhooks/zoom/route")).POST)
    const response = await POST(zoomRequest(zoomEvent))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: "accepted",
      meetingId: "meet_zoom_zoom-uuid==",
    })
    expect(mocks.createMeetingIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Weekly",
        source: "zoom",
        externalSource: "zoom",
        externalId: "zoom-uuid==",
      })
    )
    expect(mocks.repositoryWorkspaces).toEqual(["ws_default"])
    expect(mocks.createMeetingIfAbsent.mock.calls[0][0]).toMatchObject({
      visibility: "workspace",
    })
    expect(mocks.enqueueMeetSumJob).toHaveBeenCalledWith("media.ingest", {
      meetingId: "meet_zoom_zoom-uuid==",
      workspaceId: "ws_default",
      platform: "zoom",
      externalId: "zoom-uuid==",
      captureEvent: expect.objectContaining({
        platform: "zoom",
        externalId: "zoom-uuid==",
        recordingUrl: "https://zoom.us/rec/download/audio",
        recordingMimeType: "audio/mp4",
      }),
    })
  })

  it("returns 200 without enqueuing for a redelivered (duplicate) event", async () => {
    mocks.createMeetingIfAbsent.mockResolvedValue({
      meeting: { id: "meet_existing" },
      created: false,
    })
    const POST = bind((await import("@/app/api/webhooks/zoom/route")).POST)
    const response = await POST(zoomRequest(zoomEvent))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      status: "duplicate",
      meetingId: "meet_existing",
    })
    expect(mocks.enqueueMeetSumJob).not.toHaveBeenCalled()
  })

  it("discards the new meeting and returns 500 when enqueueing fails", async () => {
    mocks.enqueueMeetSumJob.mockRejectedValue(new Error("redis down"))
    const POST = bind((await import("@/app/api/webhooks/zoom/route")).POST)
    const response = await POST(zoomRequest(zoomEvent))

    expect(response.status).toBe(500)
    expect(mocks.discardMeeting).toHaveBeenCalledWith("meet_zoom_zoom-uuid==")
  })

  it("files recordings into MEETSUM_CAPTURE_WORKSPACE_ID", async () => {
    vi.stubEnv("MEETSUM_CAPTURE_WORKSPACE_ID", "ws_capture")
    const POST = bind((await import("@/app/api/webhooks/zoom/route")).POST)

    await POST(zoomRequest(zoomEvent))

    expect(mocks.repositoryWorkspaces).toEqual(["ws_capture"])
    expect(mocks.enqueueMeetSumJob.mock.calls[0][1]).toMatchObject({
      workspaceId: "ws_capture",
    })
    expect(mocks.recordAuditLog.mock.calls[0][0]).toMatchObject({
      workspaceId: "ws_capture",
    })
  })

  it("ignores irrelevant events", async () => {
    const POST = bind((await import("@/app/api/webhooks/zoom/route")).POST)
    const response = await POST(
      zoomRequest({ event: "meeting.started", payload: { object: {} } })
    )

    await expect(response.json()).resolves.toEqual({ status: "ignored" })
    expect(mocks.createMeetingIfAbsent).not.toHaveBeenCalled()
  })
})

describe("teams webhook route", () => {
  it("echoes the Graph validation token", async () => {
    const POST = bind((await import("@/app/api/webhooks/teams/route")).POST)
    const response = await POST(
      new Request("http://localhost/api/webhooks/teams?validationToken=abc%20123", {
        method: "POST",
      })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/plain")
    await expect(response.text()).resolves.toBe("abc 123")
  })

  it("processes every notification in a batch and skips duplicates", async () => {
    mocks.createMeetingIfAbsent.mockImplementation(
      async (input: { externalId: string }) => ({
        meeting: { id: `meet_${input.externalId}` },
        created: input.externalId !== "r2",
      })
    )
    const POST = bind((await import("@/app/api/webhooks/teams/route")).POST)
    const response = await POST(
      teamsRequest({
        value: [teamsNotification("r1"), teamsNotification("r2"), teamsNotification("r3")],
      })
    )

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({
      status: "accepted",
      meetingIds: ["meet_r1", "meet_r3"],
      duplicates: ["meet_r2"],
    })
    expect(mocks.createMeetingIfAbsent).toHaveBeenCalledTimes(3)
    expect(mocks.enqueueMeetSumJob).toHaveBeenCalledTimes(2)
    expect(mocks.enqueueMeetSumJob).toHaveBeenCalledWith("media.ingest", {
      meetingId: "meet_r1",
      workspaceId: "ws_default",
      platform: "teams",
      externalId: "r1",
      captureEvent: expect.objectContaining({
        platform: "teams",
        recordingUrl: "communications/onlineMeetings('m1')/recordings('r1')",
      }),
    })
  })

  it("rejects batches with an invalid clientState", async () => {
    const POST = bind((await import("@/app/api/webhooks/teams/route")).POST)
    const response = await POST(
      teamsRequest({
        value: [teamsNotification("r1"), teamsNotification("r2", { clientState: "x" })],
      })
    )

    expect(response.status).toBe(401)
    expect(mocks.createMeetingIfAbsent).not.toHaveBeenCalled()
  })

  it("returns 500 (so Graph redelivers) and discards the meeting when enqueue fails", async () => {
    mocks.enqueueMeetSumJob.mockRejectedValueOnce(new Error("redis down"))
    const POST = bind((await import("@/app/api/webhooks/teams/route")).POST)
    const response = await POST(
      teamsRequest({ value: [teamsNotification("r1"), teamsNotification("r2")] })
    )

    expect(response.status).toBe(500)
    expect(mocks.discardMeeting).toHaveBeenCalledWith("meet_teams_r1")
    expect(mocks.enqueueMeetSumJob).toHaveBeenCalledTimes(2)
  })
})

describe("teams lifecycle route", () => {
  it("validates clientState and forwards lifecycle events", async () => {
    mocks.handleTeamsLifecycleNotifications.mockResolvedValue([
      { subscriptionId: "sub-1", lifecycleEvent: "reauthorizationRequired", action: "renewed" },
    ])
    const POST = bind((await import("@/app/api/webhooks/teams/lifecycle/route")).POST)
    const response = await POST(
      teamsRequest(
        {
          value: [
            {
              subscriptionId: "sub-1",
              lifecycleEvent: "reauthorizationRequired",
              clientState: CLIENT_STATE,
            },
          ],
        },
        "/api/webhooks/teams/lifecycle"
      )
    )

    expect(response.status).toBe(202)
    expect(mocks.handleTeamsLifecycleNotifications).toHaveBeenCalledWith([
      expect.objectContaining({ subscriptionId: "sub-1", lifecycleEvent: "reauthorizationRequired" }),
    ])

    const forged = await POST(
      teamsRequest(
        { value: [{ subscriptionId: "sub-1", lifecycleEvent: "missed", clientState: "x" }] },
        "/api/webhooks/teams/lifecycle"
      )
    )
    expect(forged.status).toBe(401)
  })
})

describe("teams subscription admin route", () => {
  it("reports not-configured status and refuses to create without config", async () => {
    vi.stubEnv("MEETSUM_STORAGE", "memory")
    testAuthState.ctx = testAuthContext({ workspaceId: "ws_default", role: "admin" })
    const routes = await import("@/app/api/integrations/teams/subscription/route")
    const GET = bind(routes.GET)
    const POST = bind(routes.POST)

    const status = await GET(new Request("http://localhost/api/integrations/teams/subscription"))
    await expect(status.json()).resolves.toMatchObject({
      configured: false,
      subscriptions: [],
    })

    const create = await POST(
      new Request("http://localhost/api/integrations/teams/subscription", { method: "POST" })
    )
    expect(create.status).toBe(503)
  })

  it("is managed only from the capture workspace", async () => {
    testAuthState.ctx = testAuthContext({ workspaceId: "ws_other", role: "owner" })
    const routes = await import("@/app/api/integrations/teams/subscription/route")

    const status = await bind(routes.GET)(
      new Request("http://localhost/api/integrations/teams/subscription")
    )

    expect(status.status).toBe(404)
  })
})
