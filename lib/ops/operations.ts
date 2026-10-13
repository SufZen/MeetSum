import { getDatabasePool } from "@/lib/db/client"

export type OperationalMetrics = {
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

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>
}

function emptyMetrics(): OperationalMetrics {
  return {
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    jobs: { completed: 0, failed: 0, pending: 0, active: 0 },
    meetings: { total: 0, completed: 0, failed: 0, scheduled: 0 },
    sync: { calendarLastSync: null, meetArtifactLastSync: null },
    storage: { mediaAssetCount: 0, totalStorageEstimateBytes: 0 },
    ai: { totalRuns: 0, avgLatencyMs: null },
    auditLog: { recentCount: 0, lastAction: null, lastActionAt: null },
  }
}

/**
 * Admin dashboard metrics for one workspace. Every aggregate is filtered by
 * `workspace_id = $1` (directly, or through the meeting / Google identity it
 * belongs to), so an admin never sees another tenant's counts.
 */
export async function gatherOperationalMetrics(
  workspaceId: string,
  options: { db?: Queryable } = {}
): Promise<OperationalMetrics> {
  if (!workspaceId) throw new Error("workspaceId is required")

  if (!options.db && process.env.MEETSUM_STORAGE !== "postgres") {
    return emptyMetrics()
  }

  const pool = options.db ?? getDatabasePool()
  const values = [workspaceId]

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
        count(*) FILTER (WHERE status = 'pending' OR status = 'waiting' OR status = 'queued') AS pending,
        count(*) FILTER (WHERE status = 'active') AS active
      FROM jobs
      WHERE workspace_id = $1
    `, values).catch(() => ({ rows: [{ completed: 0, failed: 0, pending: 0, active: 0 }] })),

    pool.query(`
      SELECT
        count(*) AS total,
        count(*) FILTER (WHERE status = 'completed') AS completed,
        count(*) FILTER (WHERE status = 'failed') AS failed,
        count(*) FILTER (WHERE status = 'scheduled' OR status = 'created') AS scheduled
      FROM meetings
      WHERE workspace_id = $1
    `, values).catch(() => ({ rows: [{ total: 0, completed: 0, failed: 0, scheduled: 0 }] })),

    pool.query(`
      SELECT
        max(s.updated_at) FILTER (WHERE s.source = 'calendar') AS calendar_last_sync,
        max(s.updated_at) FILTER (WHERE s.source = 'meet') AS meet_artifact_last_sync
      FROM google_sync_states s
      JOIN google_identities gi ON gi.id = s.google_identity_id
      WHERE gi.workspace_id = $1
    `, values).catch(() => ({ rows: [{ calendar_last_sync: null, meet_artifact_last_sync: null }] })),

    pool.query(`
      SELECT
        count(*) AS media_asset_count,
        coalesce(sum(size_bytes), 0) AS total_storage_bytes
      FROM media_assets
      WHERE workspace_id = $1
    `, values).catch(() => ({ rows: [{ media_asset_count: 0, total_storage_bytes: 0 }] })),

    pool.query(`
      SELECT
        count(*) AS total_runs,
        avg(r.latency_ms) AS avg_latency_ms
      FROM intelligence_runs r
      JOIN meetings m ON m.id = r.meeting_id
      WHERE m.workspace_id = $1
    `, values).catch(() => ({ rows: [{ total_runs: 0, avg_latency_ms: null }] })),

    pool.query(`
      SELECT
        count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS recent_count,
        (array_agg(action ORDER BY created_at DESC))[1] AS last_action,
        max(created_at) AS last_action_at
      FROM audit_logs
      WHERE workspace_id = $1
    `, values).catch(() => ({ rows: [{ recent_count: 0, last_action: null, last_action_at: null }] })),
  ])

  const jobs = jobsResult.rows[0] as Record<string, unknown>
  const meetings = meetingsResult.rows[0] as Record<string, unknown>
  const sync = syncResult.rows[0] as Record<string, unknown>
  const storage = storageResult.rows[0] as Record<string, unknown>
  const ai = aiResult.rows[0] as Record<string, unknown>
  const audit = auditResult.rows[0] as Record<string, unknown>

  return {
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
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
      meetArtifactLastSync: sync.meet_artifact_last_sync
        ? String(sync.meet_artifact_last_sync)
        : null,
    },
    storage: {
      mediaAssetCount: Number(storage.media_asset_count ?? 0),
      totalStorageEstimateBytes: Number(storage.total_storage_bytes ?? 0),
    },
    ai: {
      totalRuns: Number(ai.total_runs ?? 0),
      avgLatencyMs:
        ai.avg_latency_ms != null ? Math.round(Number(ai.avg_latency_ms)) : null,
    },
    auditLog: {
      recentCount: Number(audit.recent_count ?? 0),
      lastAction: audit.last_action ? String(audit.last_action) : null,
      lastActionAt: audit.last_action_at ? String(audit.last_action_at) : null,
    },
  }
}
