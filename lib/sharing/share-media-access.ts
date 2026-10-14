import { getSessionSecret, readRequestCookie } from "@/lib/auth/session"
import type { MeetingShare, ShareMediaLookupResult } from "@/lib/meetings/repository"
import { lookupPublicShareMedia } from "@/lib/sharing/public-share"
import {
  SHARE_ACCESS_COOKIE,
  verifyShareAccessCookie,
} from "@/lib/sharing/share-access"
import { getLogger } from "@/lib/log"

const log = getLogger({ component: "sharing" })

/**
 * Gate for the public share media routes (M4 Package A). Every failure is
 * the same "not found" so a token never reveals why media is unavailable:
 * the share must be active (not revoked/expired) on a `link` meeting, the
 * workspace must allow public sharing, the share must include the opt-in
 * `media` section and, for password shares, the request must carry a valid
 * share-access cookie.
 */

export type ShareMediaDeps = {
  /** Defaults to the lightweight lookup (share + media rows, no transcript). */
  lookup?: (token: string) => Promise<ShareMediaLookupResult | undefined>
  secret?: () => string
  now?: () => number
}

/**
 * Path of the share-access cookie copy sent with media requests: the page
 * cookie is scoped to `/share/<token>`, which the browser does not send to
 * `/api/share/<token>/media`.
 */
export function getShareMediaCookiePath(token: string) {
  return `/api/share/${encodeURIComponent(token)}`
}

function isActive(share: MeetingShare, now: number) {
  if (share.revoked) return false
  if (share.expiresAt && Date.parse(share.expiresAt) <= now) return false
  return true
}

export async function authorizeShareMediaRequest(
  request: Pick<Request, "headers">,
  token: string,
  deps: ShareMediaDeps = {}
): Promise<ShareMediaLookupResult | undefined> {
  if (!token) return undefined

  let result: ShareMediaLookupResult | undefined

  try {
    result = await (deps.lookup ?? lookupPublicShareMedia)(token)
  } catch (error) {
    log.error({ errorName: (error as Error)?.name ?? error }, "Share media lookup failed")
    return undefined
  }

  if (!result) return undefined

  const { share, meeting } = result
  const now = deps.now?.() ?? Date.now()

  if (share.token !== token || !isActive(share, now)) return undefined
  if (meeting.visibility !== undefined && meeting.visibility !== "link") return undefined
  if (!share.includedSections.includes("media")) return undefined

  if (share.passwordHash) {
    let secret: string

    try {
      secret = (deps.secret ?? getSessionSecret)()
    } catch {
      return undefined
    }

    const valid = verifyShareAccessCookie(readRequestCookie(request, SHARE_ACCESS_COOKIE), {
      token,
      passwordHash: share.passwordHash,
      secret,
      now,
    })

    if (!valid) return undefined
  }

  return result
}
