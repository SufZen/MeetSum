import { withAuthz } from "@/lib/auth/authz"
import { openLiveTranscriptStream } from "@/lib/bot/live/stream"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Params = { id: string }

/**
 * GET /api/meetings/[id]/bot/live — live draft transcript as Server-Sent
 * Events (M7 B8; MEETSUM_LIVE_TRANSCRIPT only). Not the final transcript.
 */
export const GET = withAuthz<Params>("meeting:read", async (request, ctx, route) => {
  const { id } = await route.params

  return openLiveTranscriptStream(request, ctx, id)
})
