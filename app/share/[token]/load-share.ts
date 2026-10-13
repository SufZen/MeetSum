import { cache } from "react"

import { lookupPublicShare } from "@/lib/sharing/public-share"

/** Per-request memoized share lookup shared by the share layout and page. */
export const loadShare = cache((token: string) => lookupPublicShare(token))
