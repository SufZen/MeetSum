import { cache } from "react"

import { meetingRepository } from "@/lib/meetings/store"

/** Per-request memoized share lookup shared by the share layout and page. */
export const loadShare = cache((token: string) =>
  meetingRepository.getShareByToken(token)
)
