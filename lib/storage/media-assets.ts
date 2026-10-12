import { getDatabasePool } from "@/lib/db/client"
import type { RepoScope } from "@/lib/meetings/repository"
import { meetingScopeSql } from "@/lib/meetings/visibility"
import { deleteMeetingObject } from "@/lib/storage/object-storage"

export type MediaAssetView = {
  id: string
  meetingId: string
  meetingTitle: string
  storageKey: string
  filename?: string
  contentType: string
  sizeBytes: number
  retention: "audio" | "video"
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
             a.filename, a.content_type, a.size_bytes, a.retention, a.created_at
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
             a.filename, a.content_type, a.size_bytes, a.retention, a.created_at
      from media_assets a
      join meetings m on m.id = a.meeting_id
      where a.id = $1 and a.workspace_id = $2 and ${visible}
    `,
    values
  )
  const row = result.rows[0] as MediaAssetRow | undefined

  if (!row) throw new MediaAssetNotFoundError()

  await deleteMeetingObject(row.storage_key)
  await pool.query("delete from media_assets where id = $1 and workspace_id = $2", [
    id,
    scope.workspaceId,
  ])

  return mapMediaAsset(row)
}
