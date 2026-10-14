/**
 * Niqqud-insensitive transcript search (M4, client-safe, pure).
 *
 * M10 (R12): folding delegates to the M6 normalizer (`foldWithOffsets` from
 * `lib/search/hebrew-normalize`, the single text-folding authority), so the
 * in-transcript finder and ⌘K search agree: niqqud and cantillation are
 * stripped, final letters fold, Latin is lower-cased, maqaf is a space,
 * geresh/gershayim after a Hebrew letter drop (`צה״ל` = `צהל`), and a
 * hyphen-attached prefix drops (`ב-Supabase` finds `Supabase`). Curly quotes
 * and dashes are mapped to ASCII first (same length, so offsets hold).
 *
 * Every folded unit remembers the span of the original text it came from;
 * a span ends after the code point and any combining marks that follow it,
 * so a highlight never splits a letter from its niqqud.
 */
import { foldWithOffsets } from "@/lib/search/hebrew-normalize"

export type NormalizedText = {
  text: string
  /** Original start offset (UTF-16) of each normalized code unit. */
  starts: number[]
  /** Original end offset (exclusive) of each normalized code unit. */
  ends: number[]
}

const ASCII_FOLDS: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‛": "'",
  "`": "'",
  "´": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "–": "-",
}

const TRAILING_MARK = /[\p{M}\p{Cf}]/u

/** End (exclusive) of the code point at `index`, plus following marks. */
function spanEnd(original: string, index: number): number {
  const codePoint = original.codePointAt(index)
  let end = index + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1)

  while (end < original.length) {
    const next = String.fromCodePoint(original.codePointAt(end) ?? 0)

    if (!TRAILING_MARK.test(next)) break
    end += next.length
  }

  return end
}

export function normalizeForSearch(original: string): NormalizedText {
  const prepared = original.replace(/[‘’‛`´“”„–]/g, (char) => ASCII_FOLDS[char] ?? char)
  const { folded, map } = foldWithOffsets(prepared)

  return { text: folded, starts: map, ends: map.map((index) => spanEnd(original, index)) }
}

export type SearchableSegment = {
  id: string
  speaker: string
  speakerId?: string
  text: string
}

/** Filter key of a segment's speaker: the speaker id, else its legacy label. */
export function segmentSpeakerKey(segment: Pick<SearchableSegment, "speaker" | "speakerId">): string {
  return segment.speakerId ?? `label:${segment.speaker}`
}

export type SearchMatch = {
  segmentIndex: number
  segmentId: string
  /** Original text offsets of the match. */
  start: number
  end: number
  /** Position in the overall match list. */
  matchIndex: number
}

export type SearchIndex = {
  segments: readonly SearchableSegment[]
  normalized: NormalizedText[]
}

export function createSearchIndex(segments: readonly SearchableSegment[]): SearchIndex {
  return { segments, normalized: segments.map((segment) => normalizeForSearch(segment.text)) }
}

export type SearchOptions = {
  /** Only segments whose `segmentSpeakerKey` is in this set. */
  speakerKeys?: ReadonlySet<string>
}

export function searchIndex(
  index: SearchIndex,
  query: string,
  options: SearchOptions = {}
): SearchMatch[] {
  const needle = normalizeForSearch(query.trim()).text

  if (!needle) return []

  const matches: SearchMatch[] = []

  index.segments.forEach((segment, segmentIndex) => {
    if (options.speakerKeys && !options.speakerKeys.has(segmentSpeakerKey(segment))) return

    const haystack = index.normalized[segmentIndex]
    let from = haystack.text.indexOf(needle)

    while (from >= 0) {
      const last = from + needle.length - 1

      matches.push({
        segmentIndex,
        segmentId: segment.id,
        start: haystack.starts[from],
        end: haystack.ends[last],
        matchIndex: matches.length,
      })
      from = haystack.text.indexOf(needle, from + needle.length)
    }
  })

  return matches
}

export function searchTranscript(
  segments: readonly SearchableSegment[],
  query: string,
  options: SearchOptions = {}
): SearchMatch[] {
  return searchIndex(createSearchIndex(segments), query, options)
}

/** Next/previous match index, wrapping; -1 when there are none. */
export function stepMatch(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return -1
  if (current < 0) return direction === 1 ? 0 : total - 1

  return (((current + direction) % total) + total) % total
}
