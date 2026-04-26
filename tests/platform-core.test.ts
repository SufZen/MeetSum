import { describe, expect, it } from "vitest"

import {
  GOOGLE_WORKSPACE_SCOPES,
  buildGoogleSyncPlan,
} from "@/lib/google/workspace"
import { getWorkspaceAuthStatus } from "@/lib/google/auth"
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
        mode: "incremental-polling",
      },
      {
        source: "gmail",
        subject: "admin@example.com",
        mode: "polling",
      },
      {
        source: "drive",
        subject: "admin@example.com",
        mode: "recording-polling",
      },
    ])
  })

  it("defaults Workspace DWD to keyless IAM signing when no private key is present", () => {
    const previousEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
    const previousWorkspace = process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT
    const previousPrivateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
    const previousKeyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE

    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL =
      "meetsum-workspace-sync@meetsum-494211.iam.gserviceaccount.com"
    delete process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT
    delete process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE

    expect(getWorkspaceAuthStatus("info@realization.co.il")).toMatchObject({
      subject: "info@realization.co.il",
      strategy: "keyless-iam-signjwt",
      configured: true,
    })

    if (previousEmail === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
    else process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = previousEmail
    if (previousWorkspace === undefined) delete process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT
    else process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT = previousWorkspace
    if (previousPrivateKey === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
    else process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = previousPrivateKey
    if (previousKeyFile === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE
    else process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = previousKeyFile
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
