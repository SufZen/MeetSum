import { jsonError } from "@/lib/api/responses"
import { withPublicRoute } from "@/lib/auth/authz"
import { serveMeetingMedia } from "@/lib/media/proxy"
import { authorizeShareMediaRequest } from "@/lib/sharing/share-media-access"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function handle(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const access = await authorizeShareMediaRequest(request, token)

  if (!access) return jsonError("Not found", 404)

  return serveMeetingMedia({ request, assets: access.mediaAssets })
}

const REASON =
  "Public share recording (opt-in media section); the unguessable token plus the share password cookie are the credential."

/**
 * GET /api/share/:token/media?variant=audio|video — the shared meeting's
 * recording, proxied (never presigned). 404 unless the share is active,
 * public sharing is enabled, the share includes `media` and any password
 * was verified.
 */
export const GET = withPublicRoute<{ token: string }>(REASON, handle)

/** HEAD /api/share/:token/media — headers only. */
export const HEAD = withPublicRoute<{ token: string }>(REASON, handle)
