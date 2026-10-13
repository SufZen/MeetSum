/**
 * Conditional request evaluation for the media proxy (M4 Package A, pure).
 *
 * - `If-None-Match` (weak comparison, `*` matches) on GET/HEAD → 304.
 *   Without it, `If-Modified-Since` ≥ Last-Modified → 304.
 * - `If-Range` (only meaningful with `Range`): a strong ETag or an HTTP date
 *   that does not match the current representation → serve the full 200
 *   instead of the requested range.
 */

export type ConditionalOutcome = "not_modified" | "ignore_range" | "proceed"

export type ConditionalInput = {
  method: string
  headers: Headers
  etag: string
  lastModified: Date
}

type AssetIdentity = {
  id: string
  checksumSha256?: string
  createdAt: string
}

function epochSeconds(value: string | undefined): number {
  const time = value ? Date.parse(value) : Number.NaN

  return Number.isFinite(time) ? Math.floor(time / 1000) : 0
}

/** `"a-<assetId>-<checksum8|createdAtEpoch>"` (strong). */
export function mediaAssetEtag(asset: AssetIdentity): string {
  const version = asset.checksumSha256
    ? asset.checksumSha256.slice(0, 8)
    : String(epochSeconds(asset.createdAt))

  return `"a-${asset.id}-${version}"`
}

/** `"p-<assetId>-<preparedAtEpoch>"` for a peaks JSON (strong). */
export function peaksEtag(asset: { id: string; preparedAt?: string }): string {
  return `"p-${asset.id}-${epochSeconds(asset.preparedAt)}"`
}

/** Last-Modified source truncated to whole seconds (HTTP date precision). */
export function httpDate(value: string | undefined): Date {
  return new Date(epochSeconds(value) * 1000)
}

function opaque(tag: string): string {
  return tag.startsWith("W/") ? tag.slice(2) : tag
}

/** Entity tags of an `If-None-Match` list (commas inside quotes kept). */
function parseEtagList(value: string): string[] {
  return value.match(/(?:W\/)?"[^"]*"|\*/g) ?? []
}

function matchesNoneMatch(header: string, etag: string): boolean {
  if (header.trim() === "*") return true

  return parseEtagList(header).some((tag) => tag === "*" || opaque(tag) === opaque(etag))
}

function parseHttpDate(value: string): number | undefined {
  const time = Date.parse(value)

  return Number.isFinite(time) ? time : undefined
}

function ifRangeMatches(header: string, etag: string, lastModified: Date): boolean {
  const value = header.trim()

  if (value.startsWith("W/")) return false
  if (value.startsWith('"')) return !etag.startsWith("W/") && value === etag

  const date = parseHttpDate(value)

  return date !== undefined && Math.floor(date / 1000) === Math.floor(lastModified.getTime() / 1000)
}

export function evaluateConditionals(input: ConditionalInput): ConditionalOutcome {
  const method = input.method.toUpperCase()
  const readOnly = method === "GET" || method === "HEAD"
  const noneMatch = input.headers.get("if-none-match")

  if (noneMatch !== null) {
    if (readOnly && matchesNoneMatch(noneMatch, input.etag)) return "not_modified"
  } else if (readOnly) {
    const modifiedSince = input.headers.get("if-modified-since")
    const since = modifiedSince ? parseHttpDate(modifiedSince) : undefined

    if (since !== undefined && input.lastModified.getTime() <= since) return "not_modified"
  }

  const ifRange = input.headers.get("if-range")

  if (ifRange !== null && input.headers.get("range") !== null) {
    if (!ifRangeMatches(ifRange, input.etag, input.lastModified)) return "ignore_range"
  }

  return "proceed"
}
