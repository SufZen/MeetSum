import { describe, expect, it } from "vitest"

import {
  GOOGLE_WORKSPACE_SCOPES,
  buildGoogleSyncPlan,
} from "@/lib/google/workspace"
import {
  shouldEscalateTranscription,
  summarizeInHebrewPrompt,
} from "@/lib/ai/policy"
import {
  canTransitionMeeting,
  MEETING_STATUS_FLOW,
  transitionMeeting,
} from "@/lib/meetings/state"
import {
  createPlatformEvent,
  signWebhookPayload,
  verifyWebhookSignature,
} from "@/lib/platform/events"

describe("meeting state machine", () => {
  it("allows the planned audio-first meeting pipeline in order", () => {
    expect(MEETING_STATUS_FLOW).toEqual([
      "created",
      "scheduled",
      "media_found",
      "media_uploaded",
      "audio_extracted",
      "transcribing",
      "diarizing",
      "summarizing",
      "indexing",
      "completed",
      "failed",
    ])

    expect(canTransitionMeeting("media_uploaded", "audio_extracted")).toBe(
      true,
    )
    expect(
      transitionMeeting(
        { id: "meet_1", status: "media_uploaded" },
        "audio_extracted",
      ),
    ).toEqual({ id: "meet_1", status: "audio_extracted" })
  })

  it("rejects skipping ahead except for failure handling", () => {
    expect(canTransitionMeeting("created", "completed")).toBe(false)
    expect(canTransitionMeeting("transcribing", "failed")).toBe(true)

    expect(() =>
      transitionMeeting({ id: "meet_1", status: "created" }, "completed"),
    ).toThrow("Invalid meeting status transition: created -> completed")
  })
})

describe("AI policy", () => {
  it("escalates low-confidence Hebrew transcription to an API provider", () => {
    expect(
      shouldEscalateTranscription({
        language: "he",
        confidence: 0.81,
        diarizationConfidence: 0.76,
      }),
    ).toBe(true)
  })

  it("keeps high-confidence local transcripts local and prompts Hebrew-first summaries", () => {
    expect(
      shouldEscalateTranscription({
        language: "he",
        confidence: 0.94,
        diarizationConfidence: 0.9,
      }),
    ).toBe(false)

    expect(summarizeInHebrewPrompt("Roadmap review")).toContain(
      "סכם את הפגישה בעברית",
    )
  })
})

describe("Google Workspace connector policy", () => {
  it("uses explicit least-privilege scope groups for domain-wide delegation", () => {
    expect(GOOGLE_WORKSPACE_SCOPES.calendar).toContain(
      "https://www.googleapis.com/auth/calendar.events.readonly",
    )
    expect(GOOGLE_WORKSPACE_SCOPES.gmail).toContain(
      "https://www.googleapis.com/auth/gmail.readonly",
    )
    expect(GOOGLE_WORKSPACE_SCOPES.drive).toContain(
      "https://www.googleapis.com/auth/drive.readonly",
    )
  })

  it("builds a sync plan for all first-class Google sources", () => {
    expect(buildGoogleSyncPlan("admin@example.com")).toEqual([
      {
        source: "calendar",
        subject: "admin@example.com",
        mode: "incremental-watch",
      },
      {
        source: "gmail",
        subject: "admin@example.com",
        mode: "polling",
      },
      {
        source: "drive",
        subject: "admin@example.com",
        mode: "changes-watch",
      },
    ])
  })
})

describe("platform events and webhooks", () => {
  it("creates signed event payloads that reject tampering", () => {
    const event = createPlatformEvent("meeting.completed", {
      meetingId: "meet_1",
    })
    const signature = signWebhookPayload(event, "secret")

    expect(verifyWebhookSignature(event, signature, "secret")).toBe(true)
    expect(
      verifyWebhookSignature(
        { ...event, data: { meetingId: "meet_2" } },
        signature,
        "secret",
      ),
    ).toBe(false)
  })
})
