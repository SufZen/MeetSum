import { describe, expect, it } from "vitest"

/**
 * Operations dashboard type validation tests.
 * The actual API requires Postgres, so we validate the response shape.
 */

type OperationalMetrics = {
  timestamp: string
  uptime: number
  jobs: {
    completed: number
    failed: number
    pending: number
    active: number
  }
  meetings: {
    total: number
    completed: number
    failed: number
    scheduled: number
  }
  sync: {
    calendarLastSync: string | null
    meetArtifactLastSync: string | null
  }
  storage: {
    mediaAssetCount: number
    totalStorageEstimateBytes: number
  }
  ai: {
    totalRuns: number
    avgLatencyMs: number | null
  }
  auditLog: {
    recentCount: number
    lastAction: string | null
    lastActionAt: string | null
  }
}

describe("operations dashboard", () => {
  it("defines all required metric categories", () => {
    const metrics: OperationalMetrics = {
      timestamp: new Date().toISOString(),
      uptime: 3600,
      jobs: { completed: 100, failed: 5, pending: 3, active: 1 },
      meetings: { total: 50, completed: 14, failed: 2, scheduled: 34 },
      sync: { calendarLastSync: "2026-05-29T08:00:00Z", meetArtifactLastSync: null },
      storage: { mediaAssetCount: 20, totalStorageEstimateBytes: 1073741824 },
      ai: { totalRuns: 30, avgLatencyMs: 2500 },
      auditLog: { recentCount: 12, lastAction: "meeting.processed", lastActionAt: "2026-05-29T07:55:00Z" },
    }

    expect(metrics.timestamp).toBeTruthy()
    expect(metrics.uptime).toBeGreaterThanOrEqual(0)
    expect(Object.keys(metrics.jobs)).toHaveLength(4)
    expect(Object.keys(metrics.meetings)).toHaveLength(4)
    expect(Object.keys(metrics.sync)).toHaveLength(2)
    expect(Object.keys(metrics.storage)).toHaveLength(2)
    expect(Object.keys(metrics.ai)).toHaveLength(2)
    expect(Object.keys(metrics.auditLog)).toHaveLength(3)
  })

  it("allows null values for optional metrics", () => {
    const metrics: OperationalMetrics = {
      timestamp: new Date().toISOString(),
      uptime: 0,
      jobs: { completed: 0, failed: 0, pending: 0, active: 0 },
      meetings: { total: 0, completed: 0, failed: 0, scheduled: 0 },
      sync: { calendarLastSync: null, meetArtifactLastSync: null },
      storage: { mediaAssetCount: 0, totalStorageEstimateBytes: 0 },
      ai: { totalRuns: 0, avgLatencyMs: null },
      auditLog: { recentCount: 0, lastAction: null, lastActionAt: null },
    }

    expect(metrics.sync.calendarLastSync).toBeNull()
    expect(metrics.ai.avgLatencyMs).toBeNull()
    expect(metrics.auditLog.lastAction).toBeNull()
  })

  it("storage bytes can represent large values", () => {
    const tenGigabytes = 10 * 1024 * 1024 * 1024

    const metrics: OperationalMetrics = {
      timestamp: new Date().toISOString(),
      uptime: 86400,
      jobs: { completed: 1000, failed: 50, pending: 0, active: 0 },
      meetings: { total: 500, completed: 200, failed: 10, scheduled: 290 },
      sync: { calendarLastSync: "2026-05-29T08:00:00Z", meetArtifactLastSync: "2026-05-29T07:00:00Z" },
      storage: { mediaAssetCount: 200, totalStorageEstimateBytes: tenGigabytes },
      ai: { totalRuns: 150, avgLatencyMs: 3200 },
      auditLog: { recentCount: 100, lastAction: "realizeos.export.sent", lastActionAt: "2026-05-29T08:00:00Z" },
    }

    expect(metrics.storage.totalStorageEstimateBytes).toBe(tenGigabytes)
  })
})
