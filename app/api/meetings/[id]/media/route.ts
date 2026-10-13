import { meetingNotFound } from "@/app/api/_lib/meeting-access"
import { loadMeetingMediaAssets } from "@/app/api/meetings/[id]/media/_lib/meeting-media"
import { withAuthz, type AuthContext } from "@/lib/auth/authz"
import { serveMeetingMedia } from "@/lib/media/proxy"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function handle(
  request: Request,
  ctx: AuthContext,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const assets = await loadMeetingMediaAssets(ctx, id)

  if (!assets) return meetingNotFound()

  return serveMeetingMedia({ request, assets })
}

/**
 * GET /api/meetings/:id/media?variant=audio|video — streams the meeting's
 * playback media through the server (Range, conditional requests). Object
 * storage is never exposed to the browser. Not audited or rate limited:
 * players issue many range requests per session.
 */
export const GET = withAuthz<{ id: string }>("meeting:read", handle)

/** HEAD /api/meetings/:id/media — headers only, never touches storage. */
export const HEAD = withAuthz<{ id: string }>("meeting:read", handle)
