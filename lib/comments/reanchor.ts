/**
 * Re-points segment comments to the segment containing `anchor.startMs`
 * after a transcript replacement (M5 C3). Re-transcription changes segment
 * ids, so each segment comment carries a time anchor. A comment whose
 * segment still exists and still covers its anchor is left alone; one
 * without a time anchor stays where it is (it lists as orphaned).
 * Worker-side (system scope of the comments' own workspace).
 */
import { getCollabBackend, type CollabBackend } from "@/lib/clips/db"
import { segmentForTime } from "@/lib/comments/targets"
import type { TranscriptSegment } from "@/lib/meetings/repository"
import { getLogger } from "@/lib/log"

const log = getLogger({ component: "comments" })

type AnchoredComment = {
  id: string
  workspaceId: string
  targetId: string
  startMs?: number
}

export type ReanchorDeps = {
  backend?: CollabBackend
  loadSegments?: (
    workspaceId: string,
    meetingId: string
  ) => Promise<Pick<TranscriptSegment, "id" | "startMs" | "endMs">[] | undefined>
}

async function defaultLoadSegments(workspaceId: string, meetingId: string) {
  const { getSystemMeetingRepository } = await import("@/lib/meetings/store")
  const meeting = await getSystemMeetingRepository(workspaceId).getMeeting(meetingId)

  return meeting?.transcript
}

function anchorStart(anchor: unknown): number | undefined {
  const raw = typeof anchor === "string" ? (JSON.parse(anchor) as unknown) : anchor
  const value = raw && typeof raw === "object" ? (raw as { startMs?: unknown }).startMs : undefined

  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * Never throws: it runs right after `replaceTranscript` inside transcription
 * jobs, and a comment hiccup must not fail (and retry) the transcription.
 */
export async function reanchorMeetingComments(
  meetingId: string,
  deps: ReanchorDeps = {}
): Promise<{ updated: number }> {
  if (!meetingId) return { updated: 0 }

  try {
    return await reanchor(meetingId, deps)
  } catch (error) {
    log.error({ errorName: (error as Error)?.name ?? error }, "Comment re-anchoring failed")
    return { updated: 0 }
  }
}

async function reanchor(meetingId: string, deps: ReanchorDeps): Promise<{ updated: number }> {
  const backend = deps.backend ?? (await getCollabBackend())
  let comments: AnchoredComment[]

  if (backend.kind === "memory") {
    comments = [...backend.db.comments.values()]
      .filter(
        (comment) =>
          comment.meetingId === meetingId && comment.targetType === "segment" && !comment.deletedAt
      )
      .map((comment) => ({
        id: comment.id,
        workspaceId: comment.workspaceId,
        targetId: comment.targetId,
        startMs: comment.anchor.startMs,
      }))
  } else {
    const result = await backend.client.query(
      `
        select c.id, c.workspace_id, c.target_id, c.anchor
        from comments c
        join meetings m on m.id = c.meeting_id and m.workspace_id = c.workspace_id
        where c.meeting_id = $1 and c.target_type = 'segment' and c.deleted_at is null
      `,
      [meetingId]
    )

    comments = (
      result.rows as Array<{ id: string; workspace_id: string; target_id: string; anchor: unknown }>
    ).map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      targetId: row.target_id,
      startMs: anchorStart(row.anchor),
    }))
  }

  const anchored = comments.filter((comment) => comment.startMs !== undefined)

  if (!anchored.length) return { updated: 0 }

  const segments = await (deps.loadSegments ?? defaultLoadSegments)(
    anchored[0].workspaceId,
    meetingId
  )

  if (!segments?.length) return { updated: 0 }

  const byId = new Map(segments.map((segment) => [segment.id, segment]))
  const moves: Array<{ id: string; targetId: string; workspaceId: string }> = []

  for (const comment of anchored) {
    const startMs = comment.startMs as number
    const current = byId.get(comment.targetId)

    if (current && current.startMs <= startMs && (current.endMs > startMs || current.startMs === startMs)) {
      continue
    }

    const next = segmentForTime(segments, startMs)

    if (next && next !== comment.targetId) {
      moves.push({ id: comment.id, targetId: next, workspaceId: comment.workspaceId })
    }
  }

  if (!moves.length) return { updated: 0 }

  if (backend.kind === "memory") {
    for (const move of moves) {
      const stored = backend.db.comments.get(move.id)

      if (stored) backend.db.comments.set(move.id, { ...stored, targetId: move.targetId })
    }
    return { updated: moves.length }
  }

  await backend.client.query(
    `
      update comments c set target_id = v.target_id
      from unnest($1::text[], $2::text[]) as v(id, target_id)
      where c.id = v.id and c.meeting_id = $3 and c.workspace_id = $4 and c.target_type = 'segment'
    `,
    [moves.map((move) => move.id), moves.map((move) => move.targetId), meetingId, anchored[0].workspaceId]
  )

  return { updated: moves.length }
}
