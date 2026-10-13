/**
 * Niqqud-insensitive transcript search (M4, client-safe, pure).
 *
 * Text is folded per character (compatibility decomposition, combining marks
 * incl. niqqud and cantillation stripped, lowercase, Hebrew final letters to
 * their regular form, maqaf to "-", geresh/gershayim and curly quotes to
 * ASCII). Every folded character remembers the span of the original text it
 * came from, so matches highlight the original (pointed) text exactly.
 */

export type NormalizedText = {
  text: string
  /** Original start offset (UTF-16) of each normalized code unit. */
  starts: number[]
  /** Original end offset (exclusive) of each normalized code unit. */
  ends: number[]
}

const FINAL_LETTERS: Record<string, string> = {
  "ך": "כ",
  "ם": "מ",
  "ן": "נ",
  "ף": "פ",
  "ץ": "צ",
}

const PUNCTUATION_FOLDS: Record<string, string> = {
  "־": "-", // maqaf
  "‐": "-",
  "‑": "-",
  "–": "-",
  "׳": "'", // geresh
  "‘": "'",
  "’": "'",
  "‛": "'",
  "`": "'",
  "´": "'",
  "״": '"', // gershayim
  "“": '"',
  "”": '"',
  "„": '"',
}

const COMBINING_MARK = /\p{M}/u

function foldChar(char: string): string {
  let result = ""

  for (const piece of char.normalize("NFKD")) {
    if (COMBINING_MARK.test(piece)) continue

    const punctuation = PUNCTUATION_FOLDS[piece]

    if (punctuation) {
      result += punctuation
      continue
    }

    const lower = piece.toLowerCase()

    result += FINAL_LETTERS[lower] ?? lower
  }

  return result
}

export function normalizeForSearch(original: string): NormalizedText {
  let text = ""
  const starts: number[] = []
  const ends: number[] = []
  let offset = 0

  for (const char of original) {
    const folded = foldChar(char)
    const end = offset + char.length

    for (let index = 0; index < folded.length; index += 1) {
      starts.push(offset)
      ends.push(end)
    }

    text += folded
    offset = end
  }

  return { text, starts, ends }
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
