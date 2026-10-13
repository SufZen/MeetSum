/**
 * M9 C2 `GET /api/analytics/overview` (docs/parity/m9.md): range validation
 * (400, at most 366 days), API keys 403 `user_required`, a foreign room 404,
 * and the requester (workspace, user, role) passed to the service.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, setRouteCtx } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

const getAnalyticsOverview = vi.hoisted(() => vi.fn())

vi.mock("@/lib/analytics/dashboard/service", () => ({ getAnalyticsOverview }))

import { GET } from "@/app/api/analytics/overview/route"
import { emptyAnalyticsOverview } from "@/lib/analytics/dashboard/compute"
import { parseAnalyticsQuery } from "@/lib/analytics/dashboard/query"

const route = { params: Promise.resolve({}) }
const call = (query: string) => GET(new Request(`http://localhost/api/analytics/overview${query}`), route)

beforeEach(async () => {
  getAnalyticsOverview.mockImplementation(async (_who: unknown, query: Parameters<typeof emptyAnalyticsOverview>[0]) => ({
    ok: true,
    overview: emptyAnalyticsOverview(query),
  }))
  setRouteCtx(await createTestCtx({ role: "admin", userId: "user_admin", email: "admin@x.example" }))
})

afterEach(() => {
  setRouteCtx(undefined)
  getAnalyticsOverview.mockReset()
})

describe("GET /api/analytics/overview", () => {
  it("defaults to the last 90 days by week and passes the requester", async () => {
    const response = await call("?tz=UTC")
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ interval: "week", tz: "UTC" })
    expect(Date.parse(body.range.to) - Date.parse(body.range.from)).toBe(90 * 86_400_000)
    expect(getAnalyticsOverview).toHaveBeenCalledWith(
      { workspaceId: "ws_a", userId: "user_admin", email: "admin@x.example", role: "admin" },
      expect.objectContaining({ scope: "workspace", timeZone: "UTC" })
    )
  })

  it("rejects bad ranges, intervals and scopes with 400", async () => {
    for (const [query, error] of [
      ["?from=2026-01-01T00:00:00Z&to=2027-01-03T00:00:00Z", "range_too_long"],
      ["?from=2026-10-10T00:00:00Z&to=2026-10-01T00:00:00Z", "invalid_range"],
      ["?from=yesterday", "invalid_range"],
      ["?interval=year", "invalid_interval"],
      ["?scope=everyone", "invalid_scope"],
      ["?roomId=../x", "invalid_room"],
    ] as const) {
      const response = await call(query)

      expect(response.status, query).toBe(400)
      expect(await response.json()).toEqual({ error })
    }
  })

  it("accepts exactly 366 days", async () => {
    expect((await call("?from=2026-01-01T00:00:00Z&to=2027-01-02T00:00:00Z")).status).toBe(200)
  })

  it("answers 404 for a room of another workspace", async () => {
    getAnalyticsOverview.mockResolvedValueOnce({ ok: false, error: "room_not_found" })

    expect((await call("?roomId=ctx_other")).status).toBe(404)
  })

  it("refuses API keys with 403 user_required", async () => {
    setRouteCtx(await createTestCtx({ principal: "api_key", role: "admin" }))

    const response = await call("")

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ reason: "user_required" })
    expect(getAnalyticsOverview).not.toHaveBeenCalled()
  })

  it("ignores an invalid tz and accepts range presets", () => {
    const parsed = parseAnalyticsQuery(new URLSearchParams("tz=Mars/Base&range=30"), {
      timeZone: "Asia/Jerusalem",
      now: new Date("2026-10-13T00:00:00Z"),
    })

    expect(parsed).toEqual({
      ok: true,
      query: {
        from: "2026-09-13T00:00:00.000Z",
        to: "2026-10-13T00:00:00.000Z",
        interval: "week",
        scope: "workspace",
        timeZone: "Asia/Jerusalem",
      },
    })
  })
})
