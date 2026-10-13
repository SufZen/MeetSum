import type {
  BotPlatform,
  MeetingLinkRejectReason,
  MeetingLinkSource,
  ParsedMeetingLink,
} from "@/lib/bot/types"

/**
 * Meeting-link parsing (M7 A2). Pure, never fetches: Meet, Zoom and Teams
 * links from a URL or pasted (Hebrew) invite text, with wrapper unwrapping,
 * bidi/HTML normalization and passcode redaction. Importable by the client
 * (join-meeting dialog preview).
 *
 * Only canonical URLs rebuilt from allowlisted hosts leave this module; the
 * user-supplied URL itself is never passed on.
 */

/** Pasted input (Join now) limit. */
export const MEETING_LINK_INPUT_MAX_CHARS = 4096
/**
 * Calendar descriptions (HTML Teams/Zoom invites) are routinely longer than
 * 4 KB: only their first 20,000 characters are scanned.
 */
export const MEETING_LINK_CALENDAR_MAX_CHARS = 20_000
/** Candidates parsed per scan, links returned, and characters per URL run. */
const MAX_CANDIDATES = 50
const MAX_LINKS = 20
const MAX_RUN_CHARS = 4096

const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩؜﻿​]/g
// RFC 3986 characters plus `{}"`, which raw Teams `context={"Tid":…}` uses.
const URL_RUN = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%{}"]+/g
const TRAILING = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", ">", '"', "'"])

const MEET_ID = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/
const ZOOM_ID = /^\d{9,11}$/
const TEAMS_NUMERIC_ID = /^\d{10,15}$/
const TEAMS_THREAD = /^19:meeting_[A-Za-z0-9_-]{8,200}@thread\.(?:v2|skype|tacv2)$/
const PASSCODE = /^[A-Za-z0-9._~-]{1,128}$/

const ZOOM_DOMAINS = ["zoom.us", "zoom.com", "zoomgov.com"]
const TEAMS_HOSTS = new Set([
  "teams.microsoft.com",
  "teams.live.com",
  "gov.teams.microsoft.us",
  "dod.teams.microsoft.us",
])
/** Hosts whose links Vexa must be told about (`teams_base_host`). */
const TEAMS_BASE_HOSTS = new Set(["teams.live.com", "gov.teams.microsoft.us", "dod.teams.microsoft.us"])

type Attempt =
  | { ok: true; link: Omit<ParsedMeetingLink, "source"> }
  | { ok: false; reason: MeetingLinkRejectReason }

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  sol: "/",
  colon: ":",
  equals: "=",
  quest: "?",
  num: "#",
  percnt: "%",
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)

      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }

    return ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * HTML decode, `href` values lifted out of their tags, tags dropped, bidi
 * controls removed, NFKC. Every pattern here is linear: single character
 * classes with bounded repetition and no nested or overlapping quantifiers
 * (calendar descriptions are attacker-controlled — anyone can send an invite).
 */
export function normalizeMeetingText(text: string): string {
  let value = decodeEntities(text)

  value = value
    // `href="X"` → `> X <`: the URL lands outside the tag the next step drops.
    .replace(/\bhref\s{0,8}=\s{0,8}"([^"]{0,4096})"/gi, " > $1 < ")
    .replace(/\bhref\s{0,8}=\s{0,8}'([^']{0,4096})'/gi, " > $1 < ")
    // `[^<>]` stops at the next tag start, so each character is scanned once.
    .replace(/<[^<>]{0,2000}>/g, " ")
  value = decodeEntities(value)

  return value.replace(BIDI_CONTROLS, "").normalize("NFKC")
}

const OPENERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" }

/** Trims trailing punctuation, keeping balanced closers. Linear in the candidate. */
function trimTrailing(candidate: string): string {
  const counts: Record<string, number> = { "(": 0, ")": 0, "[": 0, "]": 0, "{": 0, "}": 0 }

  for (const char of candidate) {
    if (char in counts) counts[char] += 1
  }

  let end = candidate.length

  while (end > 0) {
    const last = candidate[end - 1]

    if (!TRAILING.has(last)) break

    const opener = OPENERS[last]

    if (opener && counts[opener] >= counts[last]) break
    if (opener) counts[last] -= 1
    end -= 1
  }

  return candidate.slice(0, end)
}

/** `host` of `scheme://host/...` or `host/...` by string scanning (no regex). */
function hostOf(candidate: string): string {
  const lower = candidate.toLowerCase()
  const afterScheme = lower.startsWith("https://") ? 8 : lower.startsWith("http://") ? 7 : 0
  let end = afterScheme

  while (end < lower.length && !"/?#".includes(lower[end])) end += 1

  const authority = lower.slice(afterScheme, end)
  const at = authority.lastIndexOf("@")
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority
  const colon = hostPort.indexOf(":")

  return (colon >= 0 ? hostPort.slice(0, colon) : hostPort).replace(/\.$/, "")
}

function isHostname(value: string) {
  return value.length >= 3 && value.length <= 253 && value.includes(".") && /^[a-z0-9.-]+$/.test(value)
}

function isZoomHost(host: string) {
  return ZOOM_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

function isWrapperHost(host: string) {
  return (
    host === "google.com" ||
    host === "www.google.com" ||
    host.endsWith(".safelinks.protection.outlook.com") ||
    host === "urldefense.com"
  )
}

function isKnownHost(host: string) {
  return host === "meet.google.com" || isZoomHost(host) || TEAMS_HOSTS.has(host) || isWrapperHost(host)
}

function decodeRepeatedly(value: string, times = 3): string {
  let current = value

  for (let index = 0; index < times; index += 1) {
    let next: string

    try {
      next = decodeURIComponent(current)
    } catch {
      return current
    }
    if (next === current) return current
    current = next
  }

  return current
}

function passcodeOf(value: string | null): string | undefined {
  if (!value) return undefined

  const trimmed = value.trim()

  return PASSCODE.test(trimmed) ? trimmed : undefined
}

function unwrap(url: URL, raw: string): string | undefined {
  const host = url.hostname

  if ((host === "google.com" || host === "www.google.com") && url.pathname === "/url") {
    return url.searchParams.get("q") ?? url.searchParams.get("url") ?? undefined
  }
  if (host.endsWith(".safelinks.protection.outlook.com")) {
    return url.searchParams.get("url") ?? undefined
  }
  if (host === "urldefense.com") {
    const marker = raw.indexOf("/v3/__")

    if (marker < 0) return undefined

    const start = marker + "/v3/__".length
    const end = raw.indexOf("__", start)

    return end > start ? raw.slice(start, end) : undefined
  }

  return undefined
}

function parseMeet(url: URL): Attempt {
  const segments = url.pathname.split("/").filter(Boolean)

  if (segments[0]?.toLowerCase() === "lookup") return { ok: false, reason: "lookup_link" }

  const id = segments.length === 1 ? segments[0].toLowerCase() : ""

  if (!MEET_ID.test(id)) return { ok: false, reason: "unsupported_host" }

  const canonicalUrl = `https://meet.google.com/${id}`

  return { ok: true, link: { platform: "google_meet", nativeMeetingId: id, canonicalUrl, redactedUrl: canonicalUrl } }
}

function parseZoom(url: URL): Attempt {
  const segments = url.pathname.split("/").filter(Boolean)
  const first = segments[0]?.toLowerCase()

  if (first === "my") return { ok: false, reason: "personal_link" }

  let id: string | undefined

  if ((first === "j" || first === "w" || first === "s") && segments.length >= 2) id = segments[1]
  if (first === "wc" && segments[1]?.toLowerCase() === "join") id = segments[2]
  if (first === "wc" && segments[2]?.toLowerCase() === "join") id = segments[1]

  if (!id || !ZOOM_ID.test(id)) return { ok: false, reason: "unsupported_host" }

  const base = `https://${url.hostname}/j/${id}`
  const passcode = passcodeOf(url.searchParams.get("pwd"))

  return {
    ok: true,
    link: {
      platform: "zoom",
      nativeMeetingId: id,
      ...(passcode ? { passcode } : {}),
      canonicalUrl: passcode ? `${base}?pwd=${encodeURIComponent(passcode)}` : base,
      redactedUrl: base,
    },
  }
}

function parseTeams(url: URL, raw: string): Attempt {
  const host = url.hostname
  const teamsBaseHost = TEAMS_BASE_HOSTS.has(host) ? host : undefined
  const segments = url.pathname.split("/").filter(Boolean)

  if (segments[0]?.toLowerCase() === "meet" && segments.length === 2 && TEAMS_NUMERIC_ID.test(segments[1])) {
    const id = segments[1]
    const base = `https://${host}/meet/${id}`
    const passcode = passcodeOf(url.searchParams.get("p"))

    return {
      ok: true,
      link: {
        platform: "teams",
        nativeMeetingId: id,
        ...(passcode ? { passcode } : {}),
        ...(teamsBaseHost ? { teamsBaseHost } : {}),
        canonicalUrl: passcode ? `${base}?p=${encodeURIComponent(passcode)}` : base,
        redactedUrl: base,
      },
    }
  }

  if (segments[0]?.toLowerCase() === "l" && segments[1]?.toLowerCase() === "meetup-join" && segments[2]) {
    // The raw path keeps the original encoding (URL may re-encode `%`).
    const rawSegment = /\/l\/meetup-join\/([^/?#]+)/i.exec(raw)?.[1] ?? segments[2]
    const thread = decodeRepeatedly(rawSegment)

    if (!TEAMS_THREAD.test(thread)) return { ok: false, reason: "unsupported_host" }

    const tail = segments[3] && /^\d{1,5}$/.test(segments[3]) ? segments[3] : "0"
    const base = `https://${host}/l/meetup-join/${encodeURIComponent(thread)}/${tail}`
    const context = url.searchParams.get("context")
    const safeContext = context && context.length <= 1024 ? context : undefined

    return {
      ok: true,
      link: {
        platform: "teams",
        nativeMeetingId: thread,
        ...(teamsBaseHost ? { teamsBaseHost } : {}),
        canonicalUrl: safeContext ? `${base}?context=${encodeURIComponent(safeContext)}` : base,
        redactedUrl: base,
      },
    }
  }

  return { ok: false, reason: "unsupported_host" }
}

function parseCandidate(candidate: string, depth = 0): Attempt {
  if (depth > 3) return { ok: false, reason: "unsupported_host" }

  const raw = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`
  let url: URL

  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: "no_link" }
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "no_link" }
  if (url.username || url.password) return { ok: false, reason: "credentials_in_url" }
  if (url.port && url.port !== "443" && url.port !== "80") return { ok: false, reason: "unsupported_host" }

  const host = url.hostname.toLowerCase().replace(/\.$/, "")

  if (isWrapperHost(host)) {
    const inner = unwrap(url, raw)

    if (!inner) return { ok: false, reason: "unsupported_host" }

    const normalized = trimTrailing(normalizeMeetingText(inner.slice(0, MAX_RUN_CHARS)).trim())
    const schemed = /^https?:\/\//i.test(normalized)

    return schemed || (normalized.includes("/") && isHostname(hostOf(normalized)))
      ? parseCandidate(normalized, depth + 1)
      : { ok: false, reason: "unsupported_host" }
  }

  if (host === "meet.google.com") return parseMeet(url)
  if (isZoomHost(host)) return parseZoom(url)
  if (TEAMS_HOSTS.has(host)) return parseTeams(url, raw)

  return { ok: false, reason: "unsupported_host" }
}

/** Scheme offsets in a run, found with indexOf (no regex). */
function schemeOffsets(run: string): number[] {
  const lower = run.toLowerCase()
  const offsets: number[] = []
  let from = 0

  while (offsets.length < MAX_CANDIDATES) {
    const index = lower.indexOf("http", from)

    if (index < 0) break
    if (lower.startsWith("https://", index) || lower.startsWith("http://", index)) offsets.push(index)
    from = index + 4
  }

  return offsets
}

/**
 * URL candidates inside one ASCII run (a run ends at Hebrew letters, spaces,
 * ״/׳). Linear: offsets by indexOf, hosts by string scanning, each candidate
 * bounded by the next scheme offset (a wrapper keeps the rest of the run,
 * still capped at MAX_RUN_CHARS).
 */
function candidatesOf(run: string): string[] {
  const starts = schemeOffsets(run)
  const candidates: string[] = []
  const prefixEnd = starts[0] ?? run.length
  let lead = 0

  while (lead < prefixEnd && !/[A-Za-z0-9]/.test(run[lead])) lead += 1

  const prefix = run.slice(lead, prefixEnd)
  const bareHost = prefix.includes("/") ? hostOf(prefix) : ""

  if (isHostname(bareHost) && isKnownHost(bareHost)) candidates.push(prefix)

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]
    const host = hostOf(run.slice(start, Math.min(run.length, start + 300)))

    // A wrapper's own query carries the nested link: keep it whole.
    if (isWrapperHost(host)) {
      candidates.push(run.slice(start))
      break
    }

    candidates.push(run.slice(start, starts[index + 1] ?? run.length))
  }

  return candidates.map(trimTrailing).filter(Boolean)
}

function maxChars(source: MeetingLinkSource) {
  return source === "input" ? MEETING_LINK_INPUT_MAX_CHARS : MEETING_LINK_CALENDAR_MAX_CHARS
}

type Scan = { links: ParsedMeetingLink[]; rejects: MeetingLinkRejectReason[] }

function scan(text: string, source: MeetingLinkSource, limit = MAX_LINKS): Scan {
  const result: Scan = { links: [], rejects: [] }

  if (typeof text !== "string" || !text) return result
  // Pasted input over 4 KB is rejected; calendar text is truncated to a bounded prefix.
  if (source === "input" && text.length > MEETING_LINK_INPUT_MAX_CHARS) {
    result.rejects.push("too_long")
    return result
  }

  const seen = new Set<string>()
  const normalized = normalizeMeetingText(text.slice(0, maxChars(source)))
  let parsed = 0

  for (const match of normalized.matchAll(URL_RUN)) {
    for (const candidate of candidatesOf(match[0].slice(0, MAX_RUN_CHARS))) {
      if (parsed >= MAX_CANDIDATES) return result
      parsed += 1

      const attempt = parseCandidate(candidate)

      if (!attempt.ok) {
        if (attempt.reason !== "no_link") result.rejects.push(attempt.reason)
        continue
      }

      const key = `${attempt.link.platform}:${attempt.link.nativeMeetingId}`

      if (seen.has(key)) continue
      seen.add(key)
      result.links.push({ ...attempt.link, source })
      if (result.links.length >= limit) return result
    }
  }

  return result
}

/** The first supported link in `input`, or undefined. */
export function parseMeetingLink(
  input: string,
  source: MeetingLinkSource = "input"
): ParsedMeetingLink | undefined {
  return scan(input, source, 1).links[0]
}

/** Every supported link in order, de-duplicated by (platform, nativeMeetingId). */
export function extractMeetingLinks(
  text: string,
  source: MeetingLinkSource = "input"
): ParsedMeetingLink[] {
  return scan(text, source).links
}

const REJECT_PRIORITY: readonly MeetingLinkRejectReason[] = [
  "too_long",
  "credentials_in_url",
  "personal_link",
  "lookup_link",
  "unsupported_host",
  "no_link",
]

/** Why `input` yields no supported link (for 400 `invalid_meeting_link {reason}`). */
export function diagnoseMeetingLink(input: string): MeetingLinkRejectReason {
  const { rejects } = scan(input, "input")

  return REJECT_PRIORITY.find((reason) => rejects.includes(reason)) ?? "no_link"
}

export type MeetingLinkSecrets = { passcode?: string; teamsContext?: string }

/** The secrets a link carries that the redacted URL drops (sealed at rest). */
export function meetingLinkSecrets(link: ParsedMeetingLink): MeetingLinkSecrets {
  const secrets: MeetingLinkSecrets = {}

  if (link.passcode) secrets.passcode = link.passcode
  if (link.platform === "teams") {
    const context = safeUrl(link.canonicalUrl)?.searchParams.get("context")

    if (context) secrets.teamsContext = context
  }

  return secrets
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

/**
 * Rebuilds the canonical join URL from a stored redacted URL plus the
 * decrypted secrets. Only allowlisted hosts are accepted; anything else
 * yields undefined (never pass a non-canonical URL to Vexa).
 */
export function rebuildCanonicalUrl(
  platform: BotPlatform,
  redactedUrl: string | null | undefined,
  secrets: MeetingLinkSecrets = {}
): string | undefined {
  if (!redactedUrl) return undefined

  const parsed = parseMeetingLink(redactedUrl, "input")

  if (!parsed || parsed.platform !== platform) return undefined

  const url = new URL(parsed.redactedUrl)
  const passcode = passcodeOf(secrets.passcode ?? null)

  if (platform === "zoom" && passcode) url.searchParams.set("pwd", passcode)
  if (platform === "teams" && passcode && url.pathname.startsWith("/meet/")) url.searchParams.set("p", passcode)
  if (platform === "teams" && secrets.teamsContext && url.pathname.startsWith("/l/meetup-join/")) {
    url.searchParams.set("context", secrets.teamsContext.slice(0, 1024))
  }

  return url.toString()
}
