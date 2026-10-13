import { cache } from "react"

import { lookupClipShare } from "@/lib/clips/store"
import { lookupPublicShare } from "@/lib/sharing/public-share"

/** Per-request memoized share lookup shared by the share layout and page. */
export const loadShare = cache((token: string) => lookupPublicShare(token))

/**
 * Per-request memoized clip-share lookup (M5). Clip tokens are tried first
 * and never resolve as meeting shares.
 */
export const loadClipShare = cache((token: string) => lookupClipShare(token))
