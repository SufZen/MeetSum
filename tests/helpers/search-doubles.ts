/**
 * Minimal, spec-shaped test doubles for Package A's normalizer and chunkers
 * (docs/parity/m6.md A1-A3). Package B's unit tests mock A's modules with
 * these so they stay deterministic while A's real modules land in parallel:
 *
 *   vi.mock("@/lib/search/hebrew-normalize", async () =>
 *     (await import("./helpers/search-doubles")).normalizerDouble)
 *
 * They follow the A1 contract closely enough for B's logic (prefix variants,
 * final letters, niqqud, geresh, offset maps); they are not the real thing.
 */
import { createHash } from "node:crypto"

import type { MeetingRecord, MeetingSpeaker, TranscriptSegment } from "@/lib/meetings/repository"
import type { ChunkDraft, NormalizedQuery, QueryToken, TextLanguage } from "@/lib/search/types"

const MIN_STEM_LETTERS = 3
const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  "של", "את", "על", "עם", "זה", "גם", "כי", "אם", "או", "אבל", "the", "a", "of", "to", "and",
])
const FINALS: Record<string, string> = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" }
const HEBREW_LETTER = /[א-ת]/
const MARK = /[֑-ׇֽֿׁׂׅׄ]/
const SEPARATOR = /[־׀׃]/
const GERESH = /[׳״'"’]/

/** Folds `s` and maps each folded UTF-16 index back to its source index. */
function foldWithOffsets(s: string): { folded: string; map: number[] } {
  let folded = ""
  const map: number[] = []

  for (let index = 0; index < s.length; index += 1) {
    const char = s[index]

    if (MARK.test(char)) continue
    if (SEPARATOR.test(char)) {
      folded += " "
      map.push(index)
      continue
    }
    if (GERESH.test(char) && HEBREW_LETTER.test(s[index - 1] ?? "")) continue
    if (char === "," && /\d/.test(s[index - 1] ?? "") && /^\d{3}(\D|$)/.test(s.slice(index + 1))) continue

    const normalized = (FINALS[char] ?? char).normalize("NFKC").toLowerCase()

    for (const unit of normalized) {
      for (let offset = 0; offset < unit.length; offset += 1) {
        folded += unit[offset]
        map.push(index + Math.min(offset, char.length - 1))
      }
    }
  }

  return { folded, map }
}

function foldText(s: string): string {
  return foldWithOffsets(s).folded
}

function tokenize(folded: string): string[] {
  return folded
    .replace(/(^|[^\p{L}\p{N}])[ובהכלמש]-(?=\p{L})/gu, "$1")
    .split(/[^\p{L}\p{N}.]+/u)
    .map((token) => token.replace(/^\.+|\.+$/g, ""))
    .filter((token) => token.length > 0)
    .filter((token) => !(token.length === 1 && /[ובהכלמש]/.test(token)))
}

function hebrewPrefixVariants(token: string): string[] {
  if (!/^[א-ת]+$/.test(token) || token.length < 4) return []

  const match = /^(ו)?(ש|כש|מש)?(ב|כ|ל|מ)?(ה)?/.exec(token)
  const prefix = match?.[0] ?? ""
  const variants: string[] = []

  for (let cut = prefix.length; cut >= 1; cut -= 1) {
    const rest = token.slice(cut)

    if (rest.length >= MIN_STEM_LETTERS && !variants.includes(rest)) variants.push(rest)
  }

  return variants.sort((a, b) => b.length - a.length).slice(0, 3)
}

function script(token: string): QueryToken["script"] {
  if (/^\d[\d.]*$/.test(token)) return "number"
  if (/^[א-ת]+$/.test(token)) return "he"
  if (/^[a-z0-9.]+$/.test(token)) return "latin"

  return "mixed"
}

function normalizeForIndex(text: string): { norm: string; stems: string } {
  const tokens = tokenize(foldText(text))

  return { norm: tokens.join(" "), stems: tokens.flatMap(hebrewPrefixVariants).join(" ") }
}

function normalizeQuery(q: string): NormalizedQuery {
  const folded = foldText(q).trim()

  return {
    input: q,
    folded,
    tokens: tokenize(folded).map((raw) => ({
      raw,
      variants: hebrewPrefixVariants(raw),
      script: script(raw),
      stop: QUERY_STOPWORDS.has(raw),
    })),
  }
}

function detectTextLanguage(text: string): TextLanguage {
  const letters = [...text].filter((char) => /\p{L}/u.test(char))
  const hebrew = letters.filter((char) => HEBREW_LETTER.test(char)).length
  const share = letters.length ? hebrew / letters.length : 0

  return share >= 0.6 ? "he" : share <= 0.1 ? "en" : "mixed"
}

export const normalizerDouble = {
  MIN_STEM_LETTERS,
  QUERY_STOPWORDS,
  foldText,
  foldWithOffsets,
  tokenize,
  hebrewPrefixVariants,
  normalizeForIndex,
  normalizeQuery,
  detectTextLanguage,
}

function hash(kind: string, text: string) {
  return createHash("sha256").update(`${kind}\0${text}`).digest("hex")
}

function draft(
  kind: ChunkDraft["kind"],
  chunkIndex: number,
  text: string,
  extra: Partial<ChunkDraft> = {}
): ChunkDraft {
  const { norm, stems } = normalizeForIndex(text)

  return {
    kind,
    chunkIndex,
    segmentIds: [],
    segmentStartMs: [],
    segmentOffsets: [],
    overlapCount: 0,
    speakerIds: [],
    language: detectTextLanguage(text),
    text,
    textNorm: norm,
    textStem: stems,
    tokenEstimate: Math.ceil(text.length / 4),
    contentHash: hash(kind, text),
    ...extra,
  }
}

/** One chunk per speaker turn, at most `perChunk` segments, no overlap. */
function chunkTranscript(
  input: { segments: TranscriptSegment[]; speakers: MeetingSpeaker[]; meetingLanguage?: string },
  opts: { perChunk?: number } = {}
): ChunkDraft[] {
  const perChunk = opts.perChunk ?? 3
  const names = new Map(input.speakers.map((speaker) => [speaker.id, speaker.displayName ?? speaker.label]))
  const groups: TranscriptSegment[][] = []

  for (const segment of input.segments) {
    const last = groups[groups.length - 1]
    const turn = (s: TranscriptSegment) => s.turnIndex ?? s.speakerId ?? s.speaker

    if (last && turn(last[0]) === turn(segment) && last.length < perChunk) last.push(segment)
    else groups.push([segment])
  }

  return groups.map((group, chunkIndex) => {
    const first = group[0]
    const name = (first.speakerId && names.get(first.speakerId)) || first.speaker
    let text = `${name}: `
    const offsets: number[] = []

    for (const segment of group) {
      offsets.push(text.length)
      text += `${segment.text} `
    }

    return draft("transcript", chunkIndex, text.trimEnd(), {
      segmentIds: group.map((segment) => segment.id),
      segmentStartMs: group.map((segment) => segment.startMs),
      segmentOffsets: offsets,
      speakerIds: [...new Set(group.map((segment) => segment.speakerId).filter((id): id is string => Boolean(id)))],
      startMs: first.startMs,
      endMs: group[group.length - 1].endMs,
    })
  })
}

/** Summary, action-item and meta chunks. */
function buildChunkSources(meeting: MeetingRecord): ChunkDraft[] {
  const chunks: ChunkDraft[] = []
  const overview = meeting.intelligence?.overview ?? meeting.summary?.overview

  if (overview) chunks.push(draft("summary", 0, overview))

  for (const [index, item] of (meeting.summary?.actionItems ?? []).entries()) {
    chunks.push(
      draft("action_item", index, [item.title, item.owner].filter(Boolean).join(" — "), {
        sourceId: item.id,
        startMs: item.sourceStartMs,
      })
    )
  }

  const meta = [meeting.title, ...(meeting.tags ?? []), ...meeting.participants].join(" · ")

  chunks.push(draft("meta", 0, meta))

  return chunks
}

export const chunkerDouble = { chunkTranscript }
export const chunkSourcesDouble = { buildChunkSources }
