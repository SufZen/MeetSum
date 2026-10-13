/**
 * Search pagination cursor (docs/parity/m6.md, B5; owner: Package B).
 *
 * `base64url({o, h, s})`: `o` = offset, `h` = sha1 binding of
 * principal + q + filters + group, `s` = HMAC over `o.h`. A cursor replayed
 * for another query, group or principal, or with an edited offset, is
 * rejected (the route answers 400).
 *
 * The HMAC key derives from MEETSUM_SESSION_SECRET when set (stable across
 * instances); otherwise a per-process random key is used (cursors then only
 * survive within one process, which is fine for dev and tests).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

import type { SearchFilters } from "@/lib/search/types"

/** Offsets beyond the candidate cap are never produced. */
export const MAX_CURSOR_OFFSET = 10_000
const MAX_CURSOR_LENGTH = 512

export class InvalidCursorError extends Error {
  constructor() {
    super("Invalid cursor")
    this.name = "InvalidCursorError"
  }
}

let processKey: Buffer | undefined

function cursorKey(): Buffer {
  const secret = process.env.MEETSUM_SESSION_SECRET

  if (secret) return createHmac("sha256", secret).update("meetsum-search-cursor-v1").digest()

  processKey ??= randomBytes(32)

  return processKey
}

/** Canonical JSON: sorted keys, sorted string arrays, empty values dropped. */
function canonicalFilters(filters: SearchFilters): string {
  const entries = Object.entries(filters)
    .filter(([, value]) => (Array.isArray(value) ? value.length > 0 : value !== undefined && value !== ""))
    .map(([key, value]) => [key, Array.isArray(value) ? [...value].map(String).sort() : value] as const)
    .sort(([a], [b]) => a.localeCompare(b))

  return JSON.stringify(entries)
}

export function cursorBinding(input: {
  principalKey: string
  q: string
  filters: SearchFilters
  group: string
}): string {
  return createHash("sha1")
    .update([input.principalKey, input.q.trim(), canonicalFilters(input.filters), input.group].join("\u0000"))
    .digest("hex")
}

function sign(offset: number, binding: string): string {
  return createHmac("sha256", cursorKey()).update(`${offset}.${binding}`).digest("base64url").slice(0, 32)
}

export function encodeCursor(offset: number, binding: string): string {
  return Buffer.from(JSON.stringify({ o: offset, h: binding, s: sign(offset, binding) })).toString("base64url")
}

/** Offset of a valid cursor for `binding`; throws InvalidCursorError otherwise. */
export function decodeCursor(cursor: string, binding: string): number {
  if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidCursorError()

  let parsed: unknown

  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
  } catch {
    throw new InvalidCursorError()
  }

  const { o, h, s } = (parsed ?? {}) as { o?: unknown; h?: unknown; s?: unknown }

  if (
    typeof o !== "number" ||
    !Number.isInteger(o) ||
    o < 0 ||
    o > MAX_CURSOR_OFFSET ||
    typeof h !== "string" ||
    typeof s !== "string" ||
    h !== binding
  ) {
    throw new InvalidCursorError()
  }

  const expected = Buffer.from(sign(o, binding))
  const actual = Buffer.from(s)

  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new InvalidCursorError()

  return o
}
