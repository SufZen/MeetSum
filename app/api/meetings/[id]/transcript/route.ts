import { NextResponse } from "next/server"

import { meetingNotFound } from "@/app/api/_lib/meeting-access"
import {
  ifNoneMatchHits,
  transcriptEtag,
} from "@/app/api/meetings/[id]/transcript/_lib/transcript-route"
import { withAuthz } from "@/lib/auth/authz"
import {
  toTranscriptSegmentWire,
  type TranscriptResponse,
} from "@/lib/meetings/transcript-wire"

const CACHE_CONTROL = "private, no-cache"

/**
 * GET /api/meetings/:id/transcript — segments (raw word tuples) and speakers.
 * `ETag: "t-<meetingId>-<transcript_version>"`; a matching `If-None-Match`
 * answers 304 after reading only the version.
 */
export const GET = withAuthz<{ id: string }>(
  "meeting:read",
  async (request, ctx, { params }) => {
    const { id } = await params
    const version = id ? await ctx.meetings.getTranscriptVersion(id) : undefined

    if (version === undefined) return meetingNotFound()

    if (ifNoneMatchHits(request.headers.get("if-none-match"), transcriptEtag(id, version))) {
      return new Response(null, {
        status: 304,
        headers: { ETag: transcriptEtag(id, version), "Cache-Control": CACHE_CONTROL },
      })
    }

    const transcript = await ctx.meetings.getMeetingTranscript(id)

    if (!transcript) return meetingNotFound()

    const body: TranscriptResponse = {
      meetingId: id,
      version: transcript.version,
      language: transcript.language,
      segments: transcript.segments.map(toTranscriptSegmentWire),
      speakers: transcript.speakers,
    }

    return NextResponse.json(body, {
      headers: {
        ETag: transcriptEtag(id, transcript.version),
        "Cache-Control": CACHE_CONTROL,
      },
    })
  }
)
