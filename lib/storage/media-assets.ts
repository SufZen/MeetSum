import { getDatabasePool } from "@/lib/db/client"
import type { RepoScope } from "@/lib/meetings/repository"
import { meetingScopeSql } from "@/lib/meetings/visibility"
import { deleteMeetingObjects } from "@/lib/storage/object-storage"

export type MediaAssetView = {
  id: string
  meetingId: string
  meetingTitle: string
  storageKey: string
  filename?: string
  contentType: string
  sizeBytes: number
  retention: "audio" | "video"
  /** M4: `original` or a derived `playback` rendition. */
  kind: "original" | "playback"
  derivedFromAssetId?: string
  durationMs?: number
  createdAt: string
}

type MediaAssetRow = {
  id: string
  meeting_id: string
  meeting_title: string
  storage_key: string
  filename: string | null
  content_type: string
  size_bytes: string | number
  retention: "audio" | "video"
  kind?: "original" | "playback" | null
  derived_from_asset_id?: string | null
  duration_ms?: number | null
  peaks_storage_key?: string | null
  created_at: string | Date
}

function toIso(value: string | Date) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function mapMediaAsset(row: MediaAssetRow): MediaAssetView {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    meetingTitle: row.meeting_title,
    storageKey: row.storage_key,
    filename: row.filename ?? undefined,
    contentType: row.content_type,
    sizeBytes:
      typeof row.size_bytes === "number"
        ? row.size_bytes
        : Number.parseInt(row.size_bytes, 10),
    retention: row.retention,
    kind: row.kind ?? "original",
    ...(row.derived_from_asset_id ? { derivedFromAssetId: row.derived_from_asset_id } : {}),
    ...(row.duration_ms !== null && row.duration_ms !== undefined
      ? { durationMs: Number(row.duration_ms) }
      : {}),
    createdAt: toIso(row.created_at),
  }
}

/** Raised for asset ids that do not exist (or are not visible) for the caller. */
export class MediaAssetNotFoundError extends Error {
  constructor() {
    super("Media asset not found")
    this.name = "MediaAssetNotFoundError"
  }
}

/**
 * Media of the caller's workspace (storage admin view), limited to meetings
 * the caller can see: admins do NOT bypass private meetings.
 */
export async function listMediaAssets(
  scope: RepoScope,
  options: { limit?: number } = {}
) {
  if (!scope.workspaceId) throw new Error("workspaceId is required")
  if (process.env.MEETSUM_STORAGE !== "postgres") return []

  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100)
  const values: unknown[] = [scope.workspaceId]
  const visible = meetingScopeSql(scope, "m", values)
  values.push(limit)
  const result = await getDatabasePool().query(
    `
      select a.id, a.meeting_id, m.title as meeting_title, a.storage_key,
             a.filename, a.content_type, a.size_bytes, a.retention, a.kind,
             a.derived_from_asset_id, a.duration_ms, a.created_at
      from media_assets a
      join meetings m on m.id = a.meeting_id
      where a.workspace_id = $1 and ${visible}
      order by a.created_at desc
      limit $${values.length}
    `,
    values
  )

  return (result.rows as MediaAssetRow[]).map(mapMediaAsset)
}

/** Deletes an asset of a meeting the caller can see (else not found). */
export async function deleteMediaAsset(scope: RepoScope, id: string) {
  if (!scope.workspaceId) throw new Error("workspaceId is required")
  if (process.env.MEETSUM_STORAGE !== "postgres") {
    throw new Error("Media asset deletion requires Postgres storage")
  }

  const pool = getDatabasePool()
  const values: unknown[] = [id, scope.workspaceId]
  const visible = meetingScopeSql(scope, "m", values)
  const result = await pool.query(
    `
      select a.id, a.meeting_id, m.title as meeting_title, a.storage_key,
             a.filename, a.content_type, a.size_bytes, a.retention, a.kind,
             a.derived_from_asset_id, a.duration_ms, a.peaks_storage_key, a.created_at
      from media_assets a
      join meetings m on m.id = a.meeting_id
      where a.id = $1 and a.workspace_id = $2 and ${visible}
    `,
    values
  )
  const row = result.rows[0] as MediaAssetRow | undefined

  if (!row) throw new MediaAssetNotFoundError()

  // M4: derived playback renditions (rows cascade) and the peaks object go
  // with the original. Objects first: a storage failure keeps the rows.
  const derived = await pool.query(
    "select storage_key from media_assets where derived_from_asset_id = $1 and workspace_id = $2",
    [id, scope.workspaceId]
  )
  const keys = [
    ...(derived.rows as Array<{ storage_key: string }>).map((item) => item.storage_key),
    ...(row.peaks_storage_key ? [row.peaks_storage_key] : []),
    row.storage_key,
  ]
  const removed = await deleteMeetingObjects(keys)

  if (removed.failed.length) {
    throw new Error(`Could not delete ${removed.failed.length} stored object(s)`)
  }

  await pool.query("delete from media_assets where id = $1 and workspace_id = $2", [
    id,
    scope.workspaceId,
  ])

  return mapMediaAsset(row)
}

/**
 * Deletes superseded playback rendition rows (M4 media.prepare). Postgres
 * only; the caller deletes their objects. Originals are never touched.
 */
export async function deletePlaybackAssetRows(
  workspaceId: string | undefined,
  assetIds: string[]
): Promise<void> {
  if (!assetIds.length || process.env.MEETSUM_STORAGE !== "postgres") return
  if (!workspaceId) throw new Error("workspaceId is required")

  await getDatabasePool().query(
    "delete from media_assets where id = any($1::text[]) and workspace_id = $2 and kind = 'playback'",
    [assetIds, workspaceId]
  )
}
