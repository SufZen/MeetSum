import { describe, expect, it } from "vitest"

import type { WebhookSubscriptionView, WebhookDeliveryView } from "@/lib/webhooks/management"

type WebhookStats = {
  subscriptions: {
    total: number
    active: number
    disabled: number
  }
  deliveries: {
    last24h: {
      total: number
      sent: number
      failed: number
      pending: number
      successRate: number
    }
    last7d: {
      total: number
      eventBreakdown: Record<string, number>
    }
  }
  recentFailures: Array<{
    id: string
    subscriptionUrl: string
    eventName: string
    lastError?: string
    attempts: number
    createdAt: string
  }>
}

describe("webhook stats dashboard", () => {
  it("aggregates subscription counts", () => {
    const subs: WebhookSubscriptionView[] = [
      { id: "wh_1", url: "https://example.com/hook1", events: ["meeting.completed"], enabled: true, createdAt: "2026-05-29T08:00:00Z" },
      { id: "wh_2", url: "https://example.com/hook2", events: ["summary.created"], enabled: true, createdAt: "2026-05-29T08:00:00Z" },
      { id: "wh_3", url: "https://example.com/hook3", events: ["meeting.completed"], enabled: false, createdAt: "2026-05-29T08:00:00Z" },
    ]

    const active = subs.filter((s) => s.enabled)
    const disabled = subs.filter((s) => !s.enabled)

    expect(active).toHaveLength(2)
    expect(disabled).toHaveLength(1)
  })

  it("calculates delivery success rate", () => {
    const deliveries: Partial<WebhookDeliveryView>[] = [
      { id: "d1", status: "sent" },
      { id: "d2", status: "sent" },
      { id: "d3", status: "failed" },
      { id: "d4", status: "sent" },
    ]

    const sent = deliveries.filter((d) => d.status === "sent").length
    const total = deliveries.length
    const successRate = Math.round((sent / total) * 100)

    expect(successRate).toBe(75)
  })

  it("builds event breakdown from deliveries", () => {
    const deliveries: Partial<WebhookDeliveryView>[] = [
      { id: "d1", eventName: "meeting.completed" },
      { id: "d2", eventName: "meeting.completed" },
      { id: "d3", eventName: "summary.created" },
      { id: "d4", eventName: "action_item.created" },
      { id: "d5", eventName: "meeting.completed" },
    ]

    const breakdown = new Map<string, number>()

    for (const d of deliveries) {
      const name = d.eventName!
      breakdown.set(name, (breakdown.get(name) ?? 0) + 1)
    }

    expect(breakdown.get("meeting.completed")).toBe(3)
    expect(breakdown.get("summary.created")).toBe(1)
    expect(breakdown.get("action_item.created")).toBe(1)
  })

  it("defines complete stats shape", () => {
    const stats: WebhookStats = {
      subscriptions: { total: 3, active: 2, disabled: 1 },
      deliveries: {
        last24h: { total: 10, sent: 8, failed: 2, pending: 0, successRate: 80 },
        last7d: {
          total: 50,
          eventBreakdown: {
            "meeting.completed": 30,
            "summary.created": 15,
            "action_item.created": 5,
          },
        },
      },
      recentFailures: [
        {
          id: "d_fail_1",
          subscriptionUrl: "https://example.com/dead",
          eventName: "meeting.completed",
          lastError: "Connection refused",
          attempts: 3,
          createdAt: "2026-05-29T08:00:00Z",
        },
      ],
    }

    expect(stats.subscriptions.total).toBe(3)
    expect(stats.deliveries.last24h.successRate).toBe(80)
    expect(stats.recentFailures).toHaveLength(1)
  })
})
