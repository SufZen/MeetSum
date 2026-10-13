/**
 * Citation markers (docs/parity/m6.md, C4).
 *
 * The model cites with `[sN]` (transcript segments) and `[aN]` (intelligence
 * items / non-transcript chunks), possibly grouped (`[s1, s4]`). Only aliases
 * present in this request's alias map are valid (as M5 `resolveRefs`):
 * unknown ones are removed. Groups are rewritten to `[s1][s4]` so clients
 * parse one simple form. Chips are numbered by first appearance, and the
 * quote always comes from the alias entry (the cited segment's own text),
 * never from model output.
 */
import type { AskCitation } from "@/lib/ask/types"

export type AliasEntry = Omit<AskCitation, "n">
export type AliasMap = Record<string, AliasEntry>

export const QUOTE_MAX_CHARS = 160

const MARKER = /\[\s*([sa]\d+(?:\s*[,;]\s*[sa]\d+)*)\s*\]/gi
const PARTIAL_MARKER = /^\[\s*(?:[sa]\d*(?:\s*[,;]\s*(?:[sa]\d*)?)*)?\s*$/i
const MAX_PARTIAL_CHARS = 48

/** First `max` characters of a segment text, on a word boundary when possible. */
export function quoteOf(text: string, max = QUOTE_MAX_CHARS): string {
  const clean = text.replace(/\s+/g, " ").trim()

  if (clean.length <= max) return clean

  const cut = clean.slice(0, max - 1)
  const space = cut.lastIndexOf(" ")

  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`
}

function aliasesIn(group: string): string[] {
  return group
    .split(/[,;]/)
    .map((alias) => alias.trim().toLowerCase())
    .filter(Boolean)
}

/** Rewrites marker groups to `[a][b]` of valid aliases; unknown aliases vanish. */
export function normalizeMarkers(text: string, aliases: AliasMap): string {
  return text.replace(MARKER, (_match, group: string) =>
    aliasesIn(group)
      .filter((alias) => Object.hasOwn(aliases, alias))
      .map((alias) => `[${alias}]`)
      .join("")
  )
}

/** Valid aliases in order of first appearance. */
export function citedAliases(text: string, aliases: AliasMap): string[] {
  const seen: string[] = []

  for (const match of text.matchAll(MARKER)) {
    for (const alias of aliasesIn(match[1])) {
      if (Object.hasOwn(aliases, alias) && !seen.includes(alias)) seen.push(alias)
    }
  }
  return seen
}

/** Chips numbered by first appearance (`n` from 1). */
export function buildCitations(text: string, aliases: AliasMap): AskCitation[] {
  return citedAliases(text, aliases).map((alias, index) => ({ ...aliases[alias], alias, n: index + 1 }))
}

/** True when the text holds at least one valid marker. */
export function hasValidMarker(text: string, aliases: AliasMap): boolean {
  return citedAliases(text, aliases).length > 0
}

/**
 * Streaming-safe marker filter for provisional deltas: a marker split across
 * deltas (`[s` + `12]`) is held back until it closes, then normalized, so
 * the client never sees an unknown alias or half a marker.
 */
export function createMarkerStream(aliases: AliasMap) {
  let buffer = ""

  return {
    push(delta: string): string {
      buffer += delta

      const open = buffer.lastIndexOf("[")
      let emit = buffer

      if (open >= 0 && !buffer.slice(open).includes("]")) {
        const tail = buffer.slice(open)

        if (tail.length < MAX_PARTIAL_CHARS && PARTIAL_MARKER.test(tail)) {
          emit = buffer.slice(0, open)
          buffer = tail
          return normalizeMarkers(emit, aliases)
        }
      }
      buffer = ""
      return normalizeMarkers(emit, aliases)
    },
    flush(): string {
      const rest = buffer

      buffer = ""
      return normalizeMarkers(rest, aliases)
    },
  }
}
