import { NextResponse } from "next/server"

import { requireAppAccess, jsonError } from "@/lib/api/responses"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

/**
 * GET /api/admin/operations
 * Returns operational metrics for the admin dashboard.
 */
export async function GET(request: Request) {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  try {
    const metrics = await gatherOperationalMetrics()

    return NextResponse.json(metrics, { headers: rateLimit.headers })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Failed to gather metrics",
      500
    )
  }
}

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

async function gatherOperationalMetrics(): Promise<OperationalMetrics> {
  const isPostgres = process.env.MEETSUM_STORAGE === "postgres"
  const startTime = process.uptime()

  if (!isPostgres) {
    return {
      timestamp: new Date().toISOString(),
      uptime: Math.round(startTime),
      jobs: { completed: 0, failed: 0, pending: 0, active: 0 },
      meetings: { total: 0, completed: 0, failed: 0, scheduled: 0 },
      sync: { calendarLastSync: null, meetArtifactLastSync: null },
      storage: { mediaAssetCount: 0, totalStorageEstimateBytes: 0 },
      ai: { totalRuns: 0, avgLatencyMs: null },
      auditLog: { recentCount: 0, lastAction: null, lastActionAt: null },
    }
  }

  const { getDatabasePool } = await import("@/lib/db/client")
  const pool = getDatabasePool()

  // Run queries in parallel for speed
  const [
    jobsResult,
    meetingsResult,
    syncResult,
    storageResult,
    aiResult,
    auditResult,
  ] = await Promise.all([
    pool.query(`
      SELECT
        count(*) FILTER (WHERE status = 'completed') AS completed,
        count(*) FILTER (WHERE status = 'failed') AS failed,
        count(*) FILTER (WHERE status = 'pending' OR status = 'waiting') AS pending,
        count(*) FILTER (WHERE status = 'active') AS active
      FROM jobs
    `).catch(() => ({ rows: [{ completed: 0, failed: 0, pending: 0, active: 0 }] })),

    pool.query(`
      SELECT
        count(*) AS total,
        count(*) FILTER (WHERE status = 'completed') AS completed,
        count(*) FILTER (WHERE status = 'failed') AS failed,
        count(*) FILTER (WHERE status = 'scheduled' OR status = 'created') AS scheduled
      FROM meetings
    `).catch(() => ({ rows: [{ total: 0, completed: 0, failed: 0, scheduled: 0 }] })),

    pool.query(`
      SELECT
        (SELECT max(updated_at) FROM google_sync_states WHERE source = 'calendar') AS calendar_last_sync,
        (SELECT max(updated_at) FROM google_sync_states WHERE source = 'meet') AS meet_artifact_last_sync
    `).catch(() => ({ rows: [{ calendar_last_sync: null, meet_artifact_last_sync: null }] })),

    pool.query(`
      SELECT
        count(*) AS media_asset_count,
        coalesce(sum(size_bytes), 0) AS total_storage_bytes
      FROM media_assets
    `).catch(() => ({ rows: [{ media_asset_count: 0, total_storage_bytes: 0 }] })),

    pool.query(`
      SELECT
        count(*) AS total_runs,
        avg(latency_ms) AS avg_latency_ms
      FROM intelligence_runs
    `).catch(() => ({ rows: [{ total_runs: 0, avg_latency_ms: null }] })),

    pool.query(`
      SELECT
        count(*) AS recent_count,
        (SELECT action FROM audit_logs ORDER BY created_at DESC LIMIT 1) AS last_action,
        (SELECT created_at FROM audit_logs ORDER BY created_at DESC LIMIT 1) AS last_action_at
      FROM audit_logs
      WHERE created_at > now() - interval '24 hours'
    `).catch(() => ({ rows: [{ recent_count: 0, last_action: null, last_action_at: null }] })),
  ])

  const jobs = jobsResult.rows[0] as Record<string, unknown>
  const meetings = meetingsResult.rows[0] as Record<string, unknown>
  const sync = syncResult.rows[0] as Record<string, unknown>
  const storage = storageResult.rows[0] as Record<string, unknown>
  const ai = aiResult.rows[0] as Record<string, unknown>
  const audit = auditResult.rows[0] as Record<string, unknown>

  return {
    timestamp: new Date().toISOString(),
    uptime: Math.round(startTime),
    jobs: {
      completed: Number(jobs.completed ?? 0),
      failed: Number(jobs.failed ?? 0),
      pending: Number(jobs.pending ?? 0),
      active: Number(jobs.active ?? 0),
    },
    meetings: {
      total: Number(meetings.total ?? 0),
      completed: Number(meetings.completed ?? 0),
      failed: Number(meetings.failed ?? 0),
      scheduled: Number(meetings.scheduled ?? 0),
    },
    sync: {
      calendarLastSync: sync.calendar_last_sync ? String(sync.calendar_last_sync) : null,
      meetArtifactLastSync: sync.meet_artifact_last_sync ? String(sync.meet_artifact_last_sync) : null,
    },
    storage: {
      mediaAssetCount: Number(storage.media_asset_count ?? 0),
      totalStorageEstimateBytes: Number(storage.total_storage_bytes ?? 0),
    },
    ai: {
      totalRuns: Number(ai.total_runs ?? 0),
      avgLatencyMs: ai.avg_latency_ms != null ? Math.round(Number(ai.avg_latency_ms)) : null,
    },
    auditLog: {
      recentCount: Number(audit.recent_count ?? 0),
      lastAction: audit.last_action ? String(audit.last_action) : null,
      lastActionAt: audit.last_action_at ? String(audit.last_action_at) : null,
    },
  }
}
