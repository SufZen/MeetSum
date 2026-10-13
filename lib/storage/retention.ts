import { recordAuditLog } from "@/lib/audit"
import { getDatabasePool } from "@/lib/db/client"
import { getAppSettings } from "@/lib/settings/app-settings"
import { deleteMeetingObject } from "@/lib/storage/object-storage"

/**
 * audioRetentionDays (M2, C6): media files of *completed* meetings are
 * deleted once the stored file is older than the workspace's retention
 * window. Transcripts, summaries and every other meeting row are kept; only
 * the object and its media_assets row go. Scoped to one workspace per run.
 */

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>
}

export type RetentionCandidate = {
  id: string
  meetingId: string
  storageKey: string
  contentType: string
  sizeBytes: number
  createdAt: string
}

export type MediaRetentionPlan = {
  workspaceId: string
  retentionDays: number
  cutoff?: string
  candidates: RetentionCandidate[]
  totalBytes: number
}

export type MediaRetentionResult = {
  workspaceId: string
  retentionDays: number
  cutoff?: string
  dryRun: boolean
  candidates: number
  deleted: number
  deletedBytes: number
  errors: string[]
}

type RetentionDeps = {
  db?: Queryable
  now?: Date
  limit?: number
  /** Overrides the workspace setting (tests / one-off runs). */
  retentionDays?: number
  deleteObject?: (key: string) => Promise<void>
  audit?: typeof recordAuditLog
}

const DAY_MS = 24 * 60 * 60 * 1000

type CandidateRow = {
  id: string
  meeting_id: string
  storage_key: string
  content_type: string
  size_bytes: string | number
  created_at: string | Date
}

function toIso(value: string | Date) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

async function retentionDaysFor(workspaceId: string, deps: RetentionDeps) {
  if (deps.retentionDays !== undefined) return deps.retentionDays

  return (await getAppSettings(workspaceId)).audioRetentionDays
}

export async function planMediaRetention(
  options: { workspaceId: string } & RetentionDeps
): Promise<MediaRetentionPlan> {
  const { workspaceId } = options

  if (!workspaceId) throw new Error("workspaceId is required")

  const retentionDays = await retentionDaysFor(workspaceId, options)

  // 0 / negative / non-finite = keep forever.
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return { workspaceId, retentionDays, candidates: [], totalBytes: 0 }
  }

  if (!options.db && process.env.MEETSUM_STORAGE !== "postgres") {
    return { workspaceId, retentionDays, candidates: [], totalBytes: 0 }
  }

  const db = options.db ?? getDatabasePool()
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS).toISOString()
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 500), 1), 5000)
  const result = await db.query(
    `
      select a.id, a.meeting_id, a.storage_key, a.content_type, a.size_bytes,
             a.created_at
      from media_assets a
      join meetings m on m.id = a.meeting_id
      where m.workspace_id = $1
        and a.workspace_id = $1
        and m.status = 'completed'
        and a.created_at < $2
      order by a.created_at asc
      limit $3
    `,
    [workspaceId, cutoff, limit]
  )
  const candidates = (result.rows as CandidateRow[]).map((row) => ({
    id: row.id,
    meetingId: row.meeting_id,
    storageKey: row.storage_key,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes) || 0,
    createdAt: toIso(row.created_at),
  }))

  return {
    workspaceId,
    retentionDays,
    cutoff,
    candidates,
    totalBytes: candidates.reduce((sum, item) => sum + item.sizeBytes, 0),
  }
}

/**
 * Plans and (with `execute`) applies retention for one workspace. Each object
 * is deleted before its row so a storage failure leaves the row for the next
 * run; the run is audited as `media.retention.deleted`.
 */
export async function applyMediaRetention(
  options: { workspaceId: string; execute?: boolean } & RetentionDeps
): Promise<MediaRetentionResult> {
  const plan = await planMediaRetention(options)
  const result: MediaRetentionResult = {
    workspaceId: plan.workspaceId,
    retentionDays: plan.retentionDays,
    cutoff: plan.cutoff,
    dryRun: !options.execute,
    candidates: plan.candidates.length,
    deleted: 0,
    deletedBytes: 0,
    errors: [],
  }

  if (!options.execute || !plan.candidates.length) return result

  const db = options.db ?? getDatabasePool()
  const deleteObject = options.deleteObject ?? deleteMeetingObject
  const deletedIds: string[] = []

  for (const candidate of plan.candidates) {
    try {
      await deleteObject(candidate.storageKey)
      await db.query(
        `delete from media_assets where id = $1 and workspace_id = $2`,
        [candidate.id, plan.workspaceId]
      )
      result.deleted += 1
      result.deletedBytes += candidate.sizeBytes
      deletedIds.push(candidate.id)
    } catch (error) {
      result.errors.push(
        `${candidate.id}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  if (result.deleted > 0) {
    await (options.audit ?? recordAuditLog)({
      workspaceId: plan.workspaceId,
      action: "media.retention.deleted",
      actor: "system:retention",
      targetType: "workspace",
      targetId: plan.workspaceId,
      metadata: {
        retentionDays: plan.retentionDays,
        cutoff: plan.cutoff,
        deleted: result.deleted,
        deletedBytes: result.deletedBytes,
        assetIds: deletedIds.slice(0, 100),
        errors: result.errors.length,
      },
    }).catch(() => undefined)
  }

  return result
}

/** Live workspaces (retention runs iterate them one by one). */
export async function listRetentionWorkspaceIds(
  db: Queryable = getDatabasePool()
): Promise<string[]> {
  const result = await db.query(
    `select id from workspaces where deleted_at is null order by created_at asc`
  )

  return (result.rows as Array<{ id: string }>).map((row) => row.id)
}
