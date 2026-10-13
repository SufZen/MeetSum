/**
 * App links for recaps (docs/parity/m8.md, Step 0 item 7). Real; owned by
 * Package A. Uses the M4 deep-link format without a `t` offset.
 */
import { buildSegmentLink } from "@/lib/player/deep-link"

function appOrigin(env: NodeJS.ProcessEnv): string {
  return (env.NEXT_PUBLIC_APP_URL?.trim() || env.MEETINGS_APP_URL?.trim() || "").replace(/\/+$/, "")
}

/** `${APP}/{locale}?meeting=<id>`; relative when no app URL is configured. */
export function meetingAppUrl(meetingId: string, locale: string, env: NodeJS.ProcessEnv = process.env): string {
  const link = buildSegmentLink({ origin: appOrigin(env), locale, meetingId, ms: 0 })
  const [path, query = ""] = link.split("?")
  const params = new URLSearchParams(query)

  params.delete("t")

  return `${path}?${params.toString()}`
}
