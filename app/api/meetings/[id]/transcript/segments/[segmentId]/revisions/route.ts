import { NextResponse } from "next/server"

import { meetingNotFound } from "@/app/api/_lib/meeting-access"
import { withAuthz } from "@/lib/auth/authz"
import { encodeWords } from "@/lib/meetings/transcript-words"

/**
 * GET /api/meetings/:id/transcript/segments/:segmentId/revisions — prior
 * states of an edited segment, newest first (word timings as tuples).
 */
export const GET = withAuthz<{ id: string; segmentId: string }>(
  "meeting:read",
  async (_request, ctx, { params }) => {
    const { id, segmentId } = await params

    if (!id || (await ctx.meetings.getTranscriptVersion(id)) === undefined) {
      return meetingNotFound()
    }

    const revisions = await ctx.meetings.listTranscriptRevisions(id, segmentId)

    return NextResponse.json({
      revisions: revisions.map(({ words, ...revision }) =>
        words ? { ...revision, words: encodeWords(words) } : revision
      ),
    })
  }
)
