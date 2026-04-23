import { describe, expect, it } from "vitest"

import { createHealthReport } from "@/lib/health/status"

describe("health report", () => {
  it("returns service status and uptime without leaking secrets", async () => {
    const report = await createHealthReport({
      version: "0.0.1",
      startedAt: Date.now() - 1500,
      database: async () => "ok",
      redis: async () => "not_configured",
      storage: async () => "configured",
    })

    expect(report).toMatchObject({
      app: "meetsum",
      version: "0.0.1",
      services: {
        database: "ok",
        redis: "not_configured",
        storage: "configured",
      },
    })
    expect(report.uptimeSeconds).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(report)).not.toContain("DATABASE_URL")
    expect(JSON.stringify(report)).not.toContain("secret")
  })
})
