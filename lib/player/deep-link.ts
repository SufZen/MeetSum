/**
 * `?t=` deep links into a meeting or a share page (M4, client-safe, pure).
 */
import { formatClock } from "@/lib/player/time-format"

const UNIT_FORM = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/

/**
 * Parses `123`, `12.5`, `2:03`, `1:02:03`, `1m30s`, `1h2m3s` to ms; anything
 * else (including negatives) is undefined.
 */
export function parseTimeParam(value: string | null | undefined): number | undefined {
  const raw = value?.trim()

  if (!raw) return undefined

  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000)

  if (raw.includes(":")) {
    const parts = raw.split(":")

    if (parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) return undefined

    const numbers = parts.map(Number)

    if (numbers.slice(1).some((part) => part >= 60)) return undefined

    const seconds = numbers.reduce((total, part) => total * 60 + part, 0)

    return Math.round(seconds * 1000)
  }

  const match = UNIT_FORM.exec(raw)

  if (!match || (!match[1] && !match[2] && !match[3])) return undefined

  const [hours, minutes, seconds] = [match[1], match[2], match[3]].map((part) => Number(part ?? 0))

  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000)
}

function wholeSeconds(ms: number): number {
  return Math.max(0, Math.floor(ms / 1000))
}

export function buildSegmentLink({
  origin = "",
  locale,
  meetingId,
  ms,
}: {
  origin?: string
  locale: string
  meetingId: string
  ms: number
}): string {
  const params = new URLSearchParams({ meeting: meetingId, t: String(wholeSeconds(ms)) })

  return `${origin}/${locale}?${params.toString()}`
}

export function buildShareSegmentLink({
  origin = "",
  token,
  ms,
}: {
  origin?: string
  token: string
  ms: number
}): string {
  return `${origin}/share/${encodeURIComponent(token)}?t=${wholeSeconds(ms)}`
}

/** `[12:34] Dana: text` plus the link on its own line. */
export function formatSegmentCopy({
  ms,
  speaker,
  text,
  link,
}: {
  ms: number
  speaker: string
  text: string
  link?: string
}): string {
  const line = `[${formatClock(ms)}] ${speaker}: ${text}`

  return link ? `${line}\n${link}` : line
}

/** The query string without `t` (keeps the leading "?" when anything is left). */
export function withoutTimeParam(search: string): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)

  params.delete("t")

  const rest = params.toString()

  return rest ? `?${rest}` : ""
}
