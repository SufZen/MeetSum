import { describe, expect, it } from "vitest"

import { teamsCaptureAdapter } from "@/lib/capture/teams"

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
