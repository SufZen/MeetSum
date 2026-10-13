import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import type { AuthContext } from "@/lib/auth/authz"
import {
  NothingToUndoError,
  SegmentNotFoundError,
  TranscriptConflictError,
  TranscriptSpeakerNotFoundError,
  type SegmentMutationResult,
} from "@/lib/meetings/repository"
import {
  toTranscriptSegmentWire,
  type SegmentMutationResponse,
} from "@/lib/meetings/transcript-wire"

/**
 * Shared pieces of the transcript routes (M4): ETag, actor, wire mapping
 * and repository error → HTTP mapping.
 */

/** Strong ETag of a transcript version. */
export function transcriptEtag(meetingId: string, version: number): string {
  return `"t-${meetingId}-${version}"`
}

/** True when `If-None-Match` (weak or strong, or `*`) matches `etag`. */
export function ifNoneMatchHits(header: string | null, etag: string): boolean {
  if (!header) return false

  return header
    .split(",")
    .map((value) => value.trim().replace(/^W\//, ""))
    .some((value) => value === "*" || value === etag)
}

/** User id stamped on revisions (`edited_by_user_id`); API keys have none. */
export function editActorUserId(ctx: Pick<AuthContext, "principal" | "user">) {
  return ctx.principal === "user" ? ctx.user?.id : undefined
}

export function segmentNotFound() {
  return jsonError("Segment not found", 404)
}

export function mutationResponse(result: SegmentMutationResult): SegmentMutationResponse {
  return {
    segment: toTranscriptSegmentWire(result.segment),
    ...(result.segments ? { segments: result.segments.map(toTranscriptSegmentWire) } : {}),
    ...(result.speakers ? { speakers: result.speakers } : {}),
    version: result.version,
  }
}

/** Maps a transcript mutation error to its response; rethrows anything else. */
export function transcriptErrorResponse(error: unknown): Response {
  if (error instanceof SegmentNotFoundError) return segmentNotFound()
  if (error instanceof TranscriptConflictError) {
    return NextResponse.json(
      { error: "conflict", segment: toTranscriptSegmentWire(error.segment) },
      { status: 409 }
    )
  }
  if (error instanceof NothingToUndoError) {
    return NextResponse.json({ error: "nothing_to_undo" }, { status: 409 })
  }
  if (error instanceof TranscriptSpeakerNotFoundError) {
    return jsonError("speakerId is not a speaker of this meeting", 400)
  }

  throw error
}

/** Required non-negative integer `revision` of a mutation body. */
export function parseRevision(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}
