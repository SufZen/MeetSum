import { jsonError } from "@/lib/api/responses"
import { withPublicRoute } from "@/lib/auth/authz"
import { lookupClipShare } from "@/lib/clips/store"
import { serveMeetingPeaks } from "@/lib/media/proxy"
import { authorizeShareMediaRequest } from "@/lib/sharing/share-media-access"
import { getLogger } from "@/lib/log"

const log = getLogger({ component: "share/media" })

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

    // Same order as the media route: a clip-scope token never reaches the
    // parent meeting's waveform, whatever its gate outcome.
    try {
      const clip = await lookupClipShare(token)

      if (clip.kind !== "not_clip") return jsonError("Not found", 404)
    } catch (error) {
      log.error({ errorName: (error as Error)?.name ?? error }, "Clip share lookup failed")
      return jsonError("Not found", 404)
    }

    const access = await authorizeShareMediaRequest(request, token)

    if (!access) return jsonError("Not found", 404)

    return serveMeetingPeaks({ request, assets: access.mediaAssets })
  }
)
