import { Readable } from "node:stream"
import { describe, expect, it } from "vitest"

import type {
  CaptureAdapter,
  CaptureEvent,
  WebhookValidation,
} from "@/lib/capture/types"
import {
  registerCaptureAdapter,
  getCaptureAdapter,
  listCaptureAdapters,
  listCapturePlatforms,
  parseCaptureEvents,
} from "@/lib/capture/registry"

// Mock adapter for testing
const mockAdapter: CaptureAdapter = {
  platform: "test-platform",

  validateWebhook(): WebhookValidation {
    return { valid: true }
  },

  parseEvent(body): CaptureEvent | null {
    if (typeof body !== "object" || body === null) return null

    return {
      platform: "test-platform",
      eventType: "recording.available",
      externalId: "test-123",
      title: "Test Meeting",
      startedAt: "2026-05-29T10:00:00Z",
      participants: ["Alice", "Bob"],
      metadata: {},
    }
  },

  toMeetingInput(event) {
    return {
      title: event.title,
      source: "upload",
      language: "en",
      startedAt: event.startedAt,
      participants: event.participants,
    }
  },

  async downloadRecording() {
    return {
      body: Readable.from([Buffer.from("test-audio")]),
      filename: "test.mp4",
      contentType: "video/mp4",
      sizeBytes: 10,
    }
  },
}

describe("capture adapter interface", () => {
  it("adapter implements required methods", () => {
    expect(mockAdapter.platform).toBe("test-platform")
    expect(typeof mockAdapter.validateWebhook).toBe("function")
    expect(typeof mockAdapter.parseEvent).toBe("function")
    expect(typeof mockAdapter.toMeetingInput).toBe("function")
    expect(typeof mockAdapter.downloadRecording).toBe("function")
  })

  it("validateWebhook returns valid result", () => {
    const result = mockAdapter.validateWebhook({}, "")

    expect(result.valid).toBe(true)
  })

  it("parseEvent returns null for invalid input", () => {
    const result = mockAdapter.parseEvent(null)

    expect(result).toBeNull()
  })

  it("parseEvent returns CaptureEvent for valid input", () => {
    const event = mockAdapter.parseEvent({ type: "test" })

    expect(event).not.toBeNull()
    expect(event!.platform).toBe("test-platform")
    expect(event!.eventType).toBe("recording.available")
    expect(event!.title).toBe("Test Meeting")
  })

  it("toMeetingInput produces CreateMeetingInput", () => {
    const event = mockAdapter.parseEvent({ type: "test" })!
    const input = mockAdapter.toMeetingInput(event)

    expect(input.title).toBe("Test Meeting")
    expect(input.startedAt).toBe("2026-05-29T10:00:00Z")
    expect(input.participants).toEqual(["Alice", "Bob"])
  })

  it("downloadRecording returns a stream body", async () => {
    const event = mockAdapter.parseEvent({ type: "test" })!
    const result = await mockAdapter.downloadRecording(event)
    const chunks: Buffer[] = []

    for await (const chunk of result.body as Readable) chunks.push(chunk)

    expect(Buffer.concat(chunks).toString()).toBe("test-audio")
    expect(result.filename).toBe("test.mp4")
    expect(result.contentType).toBe("video/mp4")
    expect(result.sizeBytes).toBe(10)
  })
})

describe("capture adapter registry", () => {
  it("registers and retrieves adapters", () => {
    registerCaptureAdapter(mockAdapter)

    const retrieved = getCaptureAdapter("test-platform")

    expect(retrieved).toBe(mockAdapter)
  })

  it("returns undefined for unregistered platform", () => {
    const result = getCaptureAdapter("nonexistent")

    expect(result).toBeUndefined()
  })

  it("lists registered adapters", () => {
    const adapters = listCaptureAdapters()

    expect(adapters.length).toBeGreaterThan(0)
    expect(adapters.some((a) => a.platform === "test-platform")).toBe(true)
  })

  it("lists platform names", () => {
    const platforms = listCapturePlatforms()

    expect(platforms).toContain("test-platform")
  })
})

describe("parseCaptureEvents", () => {
  it("falls back to parseEvent for non-batching adapters", () => {
    expect(parseCaptureEvents(mockAdapter, { type: "test" })).toHaveLength(1)
    expect(parseCaptureEvents(mockAdapter, null)).toEqual([])
  })

  it("uses parseEvents when the adapter batches", () => {
    const batching: CaptureAdapter = {
      ...mockAdapter,
      parseEvents: () => [
        mockAdapter.parseEvent({})!,
        { ...mockAdapter.parseEvent({})!, externalId: "test-456" },
      ],
    }

    expect(parseCaptureEvents(batching, {}).map((e) => e.externalId)).toEqual([
      "test-123",
      "test-456",
    ])
  })
})
