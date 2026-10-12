import { afterEach, describe, expect, it, vi } from "vitest"

import {
  isValidTeamsRecordingResource,
  resetGraphTokenCache,
  teamsCaptureAdapter,
} from "@/lib/capture/teams"
import { CaptureConfigError } from "@/lib/capture/types"

const CLIENT_STATE = "test-teams-client-state"

const sampleNotification = {
  value: [
    {
      subscriptionId: "sub-123",
      changeType: "created" as const,
      resource: "communications/callRecords/rec-456",
      clientState: CLIENT_STATE,
      resourceData: {
        "@odata.type": "#microsoft.graph.callRecording",
        "@odata.id": "communications/callRecords/rec-456",
        id: "rec-456",
      },
    },
  ],
}

describe("teams capture adapter", () => {
  it("parses change notification", () => {
    const event = teamsCaptureAdapter.parseEvent(sampleNotification)

    expect(event).not.toBeNull()
    expect(event!.platform).toBe("teams")
    expect(event!.eventType).toBe("recording.available")
    expect(event!.externalId).toBe("rec-456")
  })

  it("returns null for non-created events", () => {
    const event = teamsCaptureAdapter.parseEvent({
      value: [
        {
          subscriptionId: "sub-123",
          changeType: "deleted",
          resource: "test",
          clientState: CLIENT_STATE,
        },
      ],
    })

    expect(event).toBeNull()
  })

  it("returns null for invalid input", () => {
    expect(teamsCaptureAdapter.parseEvent(null)).toBeNull()
    expect(teamsCaptureAdapter.parseEvent("string")).toBeNull()
    expect(teamsCaptureAdapter.parseEvent({ notValue: true })).toBeNull()
  })

  it("converts event to meeting input", () => {
    const event = teamsCaptureAdapter.parseEvent(sampleNotification)!
    const input = teamsCaptureAdapter.toMeetingInput(event)

    expect(input.source).toBe("teams")
    expect(input.language).toBe("auto")
    expect(input.title).toBe("Teams Meeting")
  })

  it("validates clientState", () => {
    const origState = process.env.TEAMS_WEBHOOK_CLIENT_STATE
    process.env.TEAMS_WEBHOOK_CLIENT_STATE = CLIENT_STATE

    const result = teamsCaptureAdapter.validateWebhook(
      {},
      JSON.stringify(sampleNotification)
    )

    expect(result.valid).toBe(true)

    process.env.TEAMS_WEBHOOK_CLIENT_STATE = origState
  })

  it("rejects mismatched clientState", () => {
    const origState = process.env.TEAMS_WEBHOOK_CLIENT_STATE
    process.env.TEAMS_WEBHOOK_CLIENT_STATE = "correct-state"

    const result = teamsCaptureAdapter.validateWebhook(
      {},
      JSON.stringify(sampleNotification)
    )

    expect(result.valid).toBe(false)

    process.env.TEAMS_WEBHOOK_CLIENT_STATE = origState
  })

  it("rejects when TEAMS_WEBHOOK_CLIENT_STATE is not set", () => {
    const origState = process.env.TEAMS_WEBHOOK_CLIENT_STATE
    delete process.env.TEAMS_WEBHOOK_CLIENT_STATE

    const result = teamsCaptureAdapter.validateWebhook({}, "{}")

    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toContain("TEAMS_WEBHOOK_CLIENT_STATE")
    }

    if (origState) process.env.TEAMS_WEBHOOK_CLIENT_STATE = origState
  })
})

describe("teams batched notifications", () => {
  it("parses every created recording notification in a batch", () => {
    const events = teamsCaptureAdapter.parseEvents!({
      value: [
        sampleNotification.value[0],
        {
          ...sampleNotification.value[0],
          resource: "communications/onlineMeetings('m1')/recordings('r2')",
          resourceData: { ...sampleNotification.value[0].resourceData, id: "r2" },
        },
        { ...sampleNotification.value[0], changeType: "updated", resourceData: { id: "r3" } },
        // duplicate of the first one within the same batch
        sampleNotification.value[0],
      ],
    })

    expect(events.map((event) => event.externalId)).toEqual(["rec-456", "r2"])
    expect(events[1].recordingUrl).toBe(
      "communications/onlineMeetings('m1')/recordings('r2')"
    )
  })

  it("drops notifications whose resource is not a Graph-relative path", () => {
    const events = teamsCaptureAdapter.parseEvents!({
      value: [
        { ...sampleNotification.value[0], resource: "https://evil.example/x" },
        { ...sampleNotification.value[0], resource: "users/../../admin" },
        { ...sampleNotification.value[0], resource: "sites/root/drive" },
        { ...sampleNotification.value[0], resource: "users/u1/recordings?x=1" },
      ],
    })

    expect(events).toEqual([])
    expect(isValidTeamsRecordingResource("users/u1/onlineMeetings/m1/recordings/r1")).toBe(true)
    expect(isValidTeamsRecordingResource("me/onlineMeetings/m1/recordings/r1")).toBe(true)
  })

  it("rejects a batch with one forged clientState", () => {
    const origState = process.env.TEAMS_WEBHOOK_CLIENT_STATE
    process.env.TEAMS_WEBHOOK_CLIENT_STATE = CLIENT_STATE

    const result = teamsCaptureAdapter.validateWebhook(
      {},
      JSON.stringify({
        value: [
          sampleNotification.value[0],
          { ...sampleNotification.value[0], clientState: "forged" },
        ],
      })
    )

    expect(result.valid).toBe(false)
    process.env.TEAMS_WEBHOOK_CLIENT_STATE = origState
  })
})

describe("teams recording download", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    resetGraphTokenCache()
  })

  function stubAzureEnv() {
    vi.stubEnv("AZURE_TENANT_ID", "tenant")
    vi.stubEnv("AZURE_CLIENT_ID", "client")
    vi.stubEnv("AZURE_CLIENT_SECRET", "secret")
  }

  it("streams the Graph /content endpoint with a cached Bearer token", async () => {
    stubAzureEnv()
    const fetchMock = vi.fn(async (input: string | URL) =>
      String(input).includes("login.microsoftonline.com")
        ? Response.json({ access_token: "graph-token", expires_in: 3600 })
        : new Response("mp4-bytes", {
            headers: { "content-type": "video/mp4", "content-length": "9" },
          })
    )
    vi.stubGlobal("fetch", fetchMock)

    const event = teamsCaptureAdapter.parseEvent(sampleNotification)!
    const download = await teamsCaptureAdapter.downloadRecording(event)
    await teamsCaptureAdapter.downloadRecording(event)

    const graphCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith("https://graph.microsoft.com/")
    )

    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("login.")).length
    ).toBe(1)
    expect(String(graphCalls[0][0])).toBe(
      "https://graph.microsoft.com/v1.0/communications/callRecords/rec-456/content"
    )
    expect(
      ((graphCalls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>)
        .Authorization
    ).toBe("Bearer graph-token")
    expect(download).toMatchObject({ contentType: "video/mp4", sizeBytes: 9 })
    expect(await new Response(download.body as ReadableStream).text()).toBe("mp4-bytes")
  })

  it("throws a config error without Azure credentials", async () => {
    vi.stubEnv("AZURE_TENANT_ID", "")
    vi.stubGlobal("fetch", vi.fn())

    await expect(
      teamsCaptureAdapter.downloadRecording(
        teamsCaptureAdapter.parseEvent(sampleNotification)!
      )
    ).rejects.toBeInstanceOf(CaptureConfigError)
  })
})
