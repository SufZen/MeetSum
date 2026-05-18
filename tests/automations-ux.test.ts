import { describe, it, expect } from "vitest"

/**
 * Tests for Phase 4: RealizeOS & Webhook UX Improvements
 *
 * These validate the data-shaping logic used by the operational pages
 * for payload previews, response body rendering, and delivery filtering.
 */

type RealizeOSExportView = {
  id: string
  meetingId: string
  status: string
  response?: Record<string, unknown>
  lastError?: string
  createdAt: string
}

type WebhookDeliveryView = {
  id: string
  subscriptionId: string
  subscriptionUrl: string
  eventName: string
  status: string
  attempts: number
  responseStatus?: number
  responseBody?: string
  lastError?: string
  createdAt: string
}

/** Matches the payload preview condition used in operational-pages.tsx */
function hasPayloadPreview(run: RealizeOSExportView): boolean {
  return !!run.response && Object.keys(run.response).length > 0
}

/** Matches the response body preview condition used in operational-pages.tsx */
function hasResponseBodyPreview(delivery: WebhookDeliveryView): boolean {
  return !!delivery.responseBody
}

/** Filters deliveries that can be retried (only failed) */
function retryableDeliveries(
  deliveries: WebhookDeliveryView[]
): WebhookDeliveryView[] {
  return deliveries.filter((d) => d.status === "failed")
}

describe("RealizeOS payload preview", () => {
  it("shows preview for exports with non-empty response objects", () => {
    const exported: RealizeOSExportView = {
      id: "exp-1",
      meetingId: "mtg-abc",
      status: "sent",
      response: { id: "ros-123", sections: 3, status: "ingested" },
      createdAt: "2025-06-01T10:00:00Z",
    }
    expect(hasPayloadPreview(exported)).toBe(true)
    expect(JSON.stringify(exported.response, null, 2)).toContain("ros-123")
  })

  it("hides preview for exports without a response", () => {
    const pending: RealizeOSExportView = {
      id: "exp-2",
      meetingId: "mtg-def",
      status: "pending",
      createdAt: "2025-06-01T10:01:00Z",
    }
    expect(hasPayloadPreview(pending)).toBe(false)
  })

  it("hides preview for exports with an empty response object", () => {
    const empty: RealizeOSExportView = {
      id: "exp-3",
      meetingId: "mtg-ghi",
      status: "sent",
      response: {},
      createdAt: "2025-06-01T10:02:00Z",
    }
    expect(hasPayloadPreview(empty)).toBe(false)
  })

  it("preserves error display alongside payload preview", () => {
    const failed: RealizeOSExportView = {
      id: "exp-4",
      meetingId: "mtg-jkl",
      status: "failed",
      lastError: "ECONNREFUSED",
      response: { partial: true },
      createdAt: "2025-06-01T10:03:00Z",
    }
    expect(hasPayloadPreview(failed)).toBe(true)
    expect(failed.lastError).toBe("ECONNREFUSED")
  })
})

describe("webhook delivery response preview", () => {
  it("shows response body when present", () => {
    const delivery: WebhookDeliveryView = {
      id: "del-1",
      subscriptionId: "sub-1",
      subscriptionUrl: "https://example.com/hook",
      eventName: "meeting.completed",
      status: "sent",
      attempts: 1,
      responseStatus: 200,
      responseBody: '{"ok":true}',
      createdAt: "2025-06-01T10:00:00Z",
    }
    expect(hasResponseBodyPreview(delivery)).toBe(true)
  })

  it("hides response body when absent", () => {
    const delivery: WebhookDeliveryView = {
      id: "del-2",
      subscriptionId: "sub-1",
      subscriptionUrl: "https://example.com/hook",
      eventName: "summary.created",
      status: "sent",
      attempts: 1,
      responseStatus: 200,
      createdAt: "2025-06-01T10:01:00Z",
    }
    expect(hasResponseBodyPreview(delivery)).toBe(false)
  })

  it("only allows retry for failed deliveries", () => {
    const deliveries: WebhookDeliveryView[] = [
      {
        id: "del-3",
        subscriptionId: "sub-1",
        subscriptionUrl: "https://example.com/hook",
        eventName: "meeting.completed",
        status: "sent",
        attempts: 1,
        createdAt: "2025-06-01T10:00:00Z",
      },
      {
        id: "del-4",
        subscriptionId: "sub-1",
        subscriptionUrl: "https://example.com/hook",
        eventName: "meeting.completed",
        status: "failed",
        attempts: 3,
        lastError: "Timeout",
        createdAt: "2025-06-01T10:01:00Z",
      },
      {
        id: "del-5",
        subscriptionId: "sub-2",
        subscriptionUrl: "https://other.com/hook",
        eventName: "summary.created",
        status: "pending",
        attempts: 0,
        createdAt: "2025-06-01T10:02:00Z",
      },
    ]

    const retryable = retryableDeliveries(deliveries)
    expect(retryable).toHaveLength(1)
    expect(retryable[0].id).toBe("del-4")
  })
})
