import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { listDeliveries, listSubscriptions } = vi.hoisted(() => ({
  listDeliveries: vi.fn(),
  listSubscriptions: vi.fn(),
}))

vi.mock("@/lib/webhooks/management", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/webhooks/management")>()),
  listWebhookDeliveries: listDeliveries,
  listWebhookSubscriptions: listSubscriptions,
}))

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

import { GET as getStats } from "@/app/api/admin/webhooks/stats/route"
import { GET as getDeliveries } from "@/app/api/webhooks/deliveries/route"
import { RATE_LIMIT_PRESETS, resetRateLimitsForTesting } from "@/lib/rate-limit"

import { createTestCtx, setRouteCtx } from "./helpers/route-ctx"

/**
 * M10 integration (D's API audit): the webhook stats count the real
 * in-flight statuses (there is no "pending" status), and the deliveries list
 * has the `admin` rate limit like the other webhook routes.
 */
const noParams = { params: Promise.resolve({}) }

function delivery(id: string, status: string) {
  return {
    id,
    status,
    eventName: "meeting.completed",
    subscriptionUrl: "https://example.com/hook",
    lastError: status === "failed" ? "500" : null,
    attempts: 1,
    createdAt: new Date().toISOString(),
  }
}

beforeEach(async () => {
  resetRateLimitsForTesting()
  listSubscriptions.mockResolvedValue([{ id: "sub_1", enabled: true }])
  setRouteCtx(await createTestCtx({ role: "admin" }))
})

afterEach(() => {
  vi.clearAllMocks()
  setRouteCtx(undefined)
})

describe("GET /api/admin/webhooks/stats", () => {
  it("counts queued, active and retrying as in flight; cancelled is terminal", async () => {
    listDeliveries.mockResolvedValue([
      delivery("d1", "queued"),
      delivery("d2", "active"),
      delivery("d3", "retrying"),
      delivery("d4", "sent"),
      delivery("d5", "failed"),
      delivery("d6", "cancelled"),
    ])

    const response = await getStats(new Request("http://localhost/api/admin/webhooks/stats"), noParams)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.deliveries.last24h).toMatchObject({ total: 6, sent: 1, failed: 1, pending: 3 })
  })
})

describe("GET /api/webhooks/deliveries", () => {
  it("lists deliveries and is rate limited with the admin preset", async () => {
    listDeliveries.mockResolvedValue([delivery("d1", "sent")])
    const request = () =>
      new Request("http://localhost/api/webhooks/deliveries?limit=nope", { headers: { "x-forwarded-for": "203.0.113.7" } })

    const first = await getDeliveries(request(), noParams)

    expect(first.status).toBe(200)
    expect((await first.json()).deliveries).toHaveLength(1)
    expect(listDeliveries).toHaveBeenCalledWith("ws_a", { subscriptionId: undefined, limit: 25 })

    for (let index = 1; index < RATE_LIMIT_PRESETS.admin.maxRequests; index += 1) {
      expect((await getDeliveries(request(), noParams)).status).toBe(200)
    }

    const blocked = await getDeliveries(request(), noParams)

    expect(blocked.status).toBe(429)
    expect(blocked.headers.get("retry-after")).toBeTruthy()
  })
})
