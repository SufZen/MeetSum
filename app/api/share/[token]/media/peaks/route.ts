import { jsonError } from "@/lib/api/responses"
import { withPublicRoute } from "@/lib/auth/authz"
import { serveMeetingPeaks } from "@/lib/media/proxy"
import { authorizeShareMediaRequest } from "@/lib/sharing/share-media-access"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/share/:token/media/peaks — waveform peaks of a shared recording,
 * behind the same gate as the media route (404 on any failure).
 */
export const GET = withPublicRoute<{ token: string }>(
  "Public share waveform peaks (opt-in media section); the token plus the share password cookie are the credential.",
  async (request, { params }) => {
    const { token } = await params
    const access = await authorizeShareMediaRequest(request, token)

    if (!access) return jsonError("Not found", 404)

    return serveMeetingPeaks({ request, assets: access.meeting.mediaAssets ?? [] })
  }
)
