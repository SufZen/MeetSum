import { jsonError } from "@/lib/api/responses"
import { withPublicRoute } from "@/lib/auth/authz"
import { serveClipMedia } from "@/lib/clips/share-media"
import { lookupClipShare } from "@/lib/clips/store"
import { serveMeetingMedia } from "@/lib/media/proxy"
import { authorizeShareMediaRequest } from "@/lib/sharing/share-media-access"
import { getLogger } from "@/lib/log"

const log = getLogger({ component: "share/media" })

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function handle(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  // M5: clip-scope tokens resolve first and never fall through to the
  // meeting recording, whatever their gate outcome.
  let clip: Awaited<ReturnType<typeof lookupClipShare>>

  try {
    clip = await lookupClipShare(token)
  } catch (error) {
    log.error({ errorName: (error as Error)?.name ?? error }, "Clip share lookup failed")
    return jsonError("Not found", 404)
  }

  if (clip.kind === "clip") return serveClipMedia({ request, clip: clip.view.clip })
  if (clip.kind === "clip_unavailable") return jsonError("Not found", 404)

  const access = await authorizeShareMediaRequest(request, token)

  if (!access) return jsonError("Not found", 404)

  return serveMeetingMedia({ request, assets: access.mediaAssets })
}

const REASON =
  "Public share recording (opt-in media section) or a shared clip's audio; the unguessable token plus the share password cookie are the credential."

/**
 * GET /api/share/:token/media — a shared clip's audio (clip tokens: only the
 * clip object), or the shared meeting's recording (meeting tokens: M4
 * semantics, `?variant=audio|video`). Always proxied, never presigned.
 * 404 unless every gate passes.
 */
export const GET = withPublicRoute<{ token: string }>(REASON, handle)

/** HEAD /api/share/:token/media — headers only. */
export const HEAD = withPublicRoute<{ token: string }>(REASON, handle)
