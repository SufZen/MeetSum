/**
 * Transcript chunker (docs/parity/m6.md, A2; owner: Package A). Pure and
 * deterministic.
 *
 * - Turns: consecutive segments with equal `turnIndex` (legacy rows without
 *   it: a speaker change starts a turn). A turn line is
 *   `"<name>: seg1 seg2…"`, name = speaker display name, else the segment's
 *   speaker, else the speaker label.
 * - Packing: whole turns are merged until the chunk reaches `minTokens`,
 *   then it closes at that turn boundary. A turn that does not fit closes
 *   the chunk first; a turn larger than a whole chunk is split at segment
 *   boundaries (the next chunk repeats the speaker label). A single segment
 *   larger than a chunk is split at a sentence, then a word; its pieces
 *   share the segment id with distinct offsets.
 * - Overlap: each chunk starts with the trailing own segments of the
 *   previous chunk, up to `overlapTokens` (`overlapCount` of them). Own
 *   content is packed to `maxTokens − overlapTokens`, so boundaries never
 *   depend on the overlap and the whole chunk stays within `maxTokens`.
 * - Boundaries are anchored to turns, so a one-segment edit changes at most
 *   two chunk hashes in the common case (its chunk and the next one's
 *   overlap).
 */
import { createHash } from "node:crypto"

import { estimateTokens } from "@/lib/intelligence/transcript-format"
import type { MeetingSpeaker, TranscriptSegment } from "@/lib/meetings/repository"
import { detectTextLanguage, normalizeForIndex } from "@/lib/search/hebrew-normalize"
import type { ChunkDraft, ChunkKind, TextLanguage } from "@/lib/search/types"

export type ChunkTranscriptInput = {
  segments: TranscriptSegment[]
  speakers: MeetingSpeaker[]
  meetingLanguage?: string
}

export type ChunkTranscriptOptions = {
  minTokens?: number
  maxTokens?: number
  overlapTokens?: number
}

type Env = Record<string, string | undefined>

const DEFAULTS = { minTokens: 250, maxTokens: 800, overlapTokens: 80 }

function positiveInt(value: string | undefined, fallback: number, allowZero = false): number {
  const parsed = Number(value)

  return Number.isInteger(parsed) && (parsed > 0 || (allowZero && parsed === 0)) ? parsed : fallback
}

/** `MEETSUM_CHUNK_{MIN,MAX,OVERLAP}_TOKENS` (250 / 800 / 80). */
export function chunkOptionsFromEnv(env: Env = process.env): Required<ChunkTranscriptOptions> {
  return {
    minTokens: positiveInt(env.MEETSUM_CHUNK_MIN_TOKENS, DEFAULTS.minTokens),
    maxTokens: positiveInt(env.MEETSUM_CHUNK_MAX_TOKENS, DEFAULTS.maxTokens),
    overlapTokens: positiveInt(env.MEETSUM_CHUNK_OVERLAP_TOKENS, DEFAULTS.overlapTokens, true),
  }
}

/** `sha256(kind + "\0" + text)`, hex. */
export function chunkContentHash(kind: ChunkKind, text: string): string {
  return createHash("sha256").update(`${kind}\0${text}`).digest("hex")
}

/** `he` / `en` / `mixed` from a stored language code, else undefined. */
export function toTextLanguage(language: string | undefined): TextLanguage | undefined {
  const code = language?.trim().toLowerCase()

  if (!code) return undefined
  if (code === "mixed") return "mixed"
  if (code === "he" || code === "iw" || code.startsWith("he-") || code.startsWith("iw-")) return "he"
  if (code === "en" || code.startsWith("en-")) return "en"

  return undefined
}

/** Max characters for a token budget under `estimateTokens` (ceil(len / 3)). */
function charsFor(tokens: number): number {
  return Math.max(1, tokens * 3)
}

const SENTENCE_END = /[.!?…]+["'”׳״)\]]*\s+/g

/** Splits `text` into pieces of at most `maxChars`: at sentences, then words, then characters. */
function splitText(text: string, maxChars: number): { text: string; offset: number }[] {
  if (text.length <= maxChars) return [{ text, offset: 0 }]

  const sentences: { text: string; offset: number }[] = []
  let start = 0

  for (const match of text.matchAll(SENTENCE_END)) {
    const end = (match.index ?? 0) + match[0].length

    sentences.push({ text: text.slice(start, end), offset: start })
    start = end
  }
  if (start < text.length) sentences.push({ text: text.slice(start), offset: start })

  const units = sentences.flatMap((sentence) =>
    sentence.text.length <= maxChars ? [sentence] : splitWords(sentence, maxChars)
  )
  const pieces: { text: string; offset: number }[] = []
  let current: { text: string; offset: number } | undefined

  for (const unit of units) {
    if (current && current.text.length + unit.text.length <= maxChars) {
      current.text += unit.text
    } else {
      if (current) pieces.push(current)
      current = { ...unit }
    }
  }
  if (current) pieces.push(current)

  return pieces
    .map((piece) => {
      const trimmed = piece.text.trimEnd()
      const lead = trimmed.length - trimmed.trimStart().length

      return { text: trimmed.trimStart(), offset: piece.offset + lead }
    })
    .filter((piece) => piece.text.length > 0)
}

function splitWords(unit: { text: string; offset: number }, maxChars: number) {
  const words: { text: string; offset: number }[] = []

  for (const match of unit.text.matchAll(/\S+\s*/g)) {
    const offset = unit.offset + (match.index ?? 0)
    let word = match[0]
    let wordOffset = offset

    while (word.length > maxChars) {
      words.push({ text: word.slice(0, maxChars), offset: wordOffset })
      word = word.slice(maxChars)
      wordOffset += maxChars
    }
    if (word) words.push({ text: word, offset: wordOffset })
  }

  return words
}

/**
 * Splits long free text (summaries, item lists) into pieces of at most
 * `maxTokens`, at sentences, then words. Offsets are into `text`.
 */
export function splitTextByTokens(text: string, maxTokens: number): { text: string; offset: number }[] {
  return splitText(text, charsFor(maxTokens))
}

type Piece = {
  segmentId: string
  startMs: number
  endMs: number
  text: string
  speakerId?: string
  language?: TextLanguage
  turn: number
  name: string
}

type Line = { turn: number; name: string; pieces: Piece[] }

function lineLength(line: Line): number {
  return line.name.length + 2 + line.pieces.reduce((sum, piece) => sum + piece.text.length, 0) + line.pieces.length - 1
}

function linesLength(lines: Line[]): number {
  return lines.length ? lines.reduce((sum, line) => sum + lineLength(line), 0) + lines.length - 1 : 0
}

function speakerNameOf(segment: TranscriptSegment, speakers: Map<string, MeetingSpeaker>): string {
  const spk = segment.speakerId ? speakers.get(segment.speakerId) : undefined

  return (spk?.displayName?.trim() || segment.speaker?.trim() || spk?.label?.trim() || "?").replace(/\s+/g, " ")
}

/** Segments in time order, grouped into turns and cut into pieces that fit a chunk. */
function buildPieces(input: ChunkTranscriptInput, ownMaxChars: number): Piece[] {
  const speakers = new Map(input.speakers.map((spk) => [spk.id, spk]))
  const ordered = input.segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => segment.text?.trim())
    .sort((a, b) => a.segment.startMs - b.segment.startMs || a.index - b.index)
    .map(({ segment }) => segment)
  const pieces: Piece[] = []
  let turn = -1
  let previous: TranscriptSegment | undefined

  for (const segment of ordered) {
    const sameTurn =
      previous !== undefined &&
      (previous.turnIndex !== undefined && segment.turnIndex !== undefined
        ? previous.turnIndex === segment.turnIndex
        : (previous.speakerId ?? previous.speaker) === (segment.speakerId ?? segment.speaker))

    if (!sameTurn) turn += 1
    previous = segment

    const name = speakerNameOf(segment, speakers)
    const text = segment.text.replace(/\s+/g, " ").trim()

    for (const part of splitText(text, Math.max(1, ownMaxChars - name.length - 2))) {
      pieces.push({
        segmentId: segment.id,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: part.text,
        speakerId: segment.speakerId,
        language: toTextLanguage(segment.language),
        turn,
        name,
      })
    }
  }

  return pieces
}

function groupTurns(pieces: Piece[]): Line[] {
  const turns: Line[] = []

  for (const piece of pieces) {
    const last = turns[turns.length - 1]

    if (last && last.turn === piece.turn) last.pieces.push(piece)
    else turns.push({ turn: piece.turn, name: piece.name, pieces: [piece] })
  }

  return turns
}

/** Greedy packing of turns into chunks of own lines (no overlap yet). */
function packTurns(turns: Line[], minChars: number, maxChars: number): Line[][] {
  const chunks: Line[][] = []
  let current: Line[] = []
  const close = () => {
    if (current.length) chunks.push(current)
    current = []
  }

  for (const turn of turns) {
    if (linesLength([...current, turn]) <= maxChars) {
      current.push({ ...turn, pieces: [...turn.pieces] })
    } else if (lineLength(turn) <= maxChars) {
      close()
      current.push({ ...turn, pieces: [...turn.pieces] })
    } else {
      for (const piece of turn.pieces) {
        const last = current[current.length - 1]
        const candidate =
          last && last.turn === turn.turn
            ? [...current.slice(0, -1), { ...last, pieces: [...last.pieces, piece] }]
            : [...current, { turn: turn.turn, name: turn.name, pieces: [piece] }]

        if (linesLength(candidate) <= maxChars) {
          current = candidate
        } else {
          close()
          current = [{ turn: turn.turn, name: turn.name, pieces: [piece] }]
        }
      }
    }

    if (linesLength(current) >= minChars) close()
  }
  close()

  return chunks
}

/** Trailing own pieces of a chunk that fit the overlap budget, as lines. */
function overlapLines(previous: Line[] | undefined, overlapChars: number): Line[] {
  if (!previous || overlapChars <= 0) return []

  const pieces = previous.flatMap((line) => line.pieces)
  const taken: Piece[] = []

  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    const candidate = groupTurns([pieces[index], ...taken])

    if (linesLength(candidate) > overlapChars) break
    taken.unshift(pieces[index])
  }

  return groupTurns(taken)
}

/** Hebrew share of letters at which a text counts as Hebrew (as Ask's HEBREW_QUESTION_RATIO). */
export const HEBREW_CHUNK_RATIO = 0.3

/**
 * Chunk language from its own segment texts (speaker labels excluded): at
 * least 30% Hebrew letters → `he`, else `en` — consistent with Ask's
 * question rule, and robust to ASR tagging code-switched Hebrew as `en`.
 * Without letters: the segment majority, then the meeting language.
 */
function chunkLanguage(pieces: Piece[], fallback: TextLanguage | undefined, text: string): TextLanguage {
  let letters = 0
  let hebrew = 0

  for (const ch of pieces.map((piece) => piece.text).join(" ")) {
    if (!/\p{L}/u.test(ch)) continue
    letters += 1
    if (ch >= "א" && ch <= "ת") hebrew += 1
  }
  if (letters > 0) return hebrew / letters >= HEBREW_CHUNK_RATIO ? "he" : "en"

  return majorityLanguage(pieces, fallback, text)
}

function majorityLanguage(pieces: Piece[], fallback: TextLanguage | undefined, text: string): TextLanguage {
  const counts = new Map<TextLanguage, number>()

  for (const piece of pieces) {
    if (piece.language) counts.set(piece.language, (counts.get(piece.language) ?? 0) + 1)
  }

  let best: TextLanguage | undefined
  let bestCount = 0

  for (const language of ["he", "en", "mixed"] as const) {
    const count = counts.get(language) ?? 0

    if (count > bestCount) {
      best = language
      bestCount = count
    }
  }

  return best ?? fallback ?? detectTextLanguage(text)
}

function toDraft(
  own: Line[],
  overlap: Line[],
  chunkIndex: number,
  meetingLanguage: TextLanguage | undefined
): ChunkDraft {
  const lines = [...overlap, ...own]
  const segmentIds: string[] = []
  const segmentStartMs: number[] = []
  const segmentOffsets: number[] = []
  let text = ""

  for (const line of lines) {
    if (text) text += "\n"
    text += `${line.name}: `
    line.pieces.forEach((piece, index) => {
      if (index > 0) text += " "
      segmentIds.push(piece.segmentId)
      segmentStartMs.push(piece.startMs)
      segmentOffsets.push(text.length)
      text += piece.text
    })
  }

  const ownPieces = own.flatMap((line) => line.pieces)
  const { norm, stems } = normalizeForIndex(text)

  return {
    kind: "transcript",
    chunkIndex,
    segmentIds,
    segmentStartMs,
    segmentOffsets,
    overlapCount: overlap.reduce((sum, line) => sum + line.pieces.length, 0),
    speakerIds: [...new Set(ownPieces.map((piece) => piece.speakerId).filter((id): id is string => Boolean(id)))],
    startMs: Math.min(...ownPieces.map((piece) => piece.startMs)),
    endMs: Math.max(...ownPieces.map((piece) => piece.endMs)),
    language: chunkLanguage(ownPieces, meetingLanguage, text),
    text,
    textNorm: norm,
    textStem: stems,
    tokenEstimate: estimateTokens(text),
    contentHash: chunkContentHash("transcript", text),
  }
}

export function chunkTranscript(input: ChunkTranscriptInput, opts?: ChunkTranscriptOptions): ChunkDraft[] {
  const defaults = chunkOptionsFromEnv()
  const maxTokens = Math.max(2, opts?.maxTokens ?? defaults.maxTokens)
  const overlapTokens = Math.min(Math.max(0, opts?.overlapTokens ?? defaults.overlapTokens), Math.floor(maxTokens / 2))
  const minTokens = Math.min(Math.max(0, opts?.minTokens ?? defaults.minTokens), maxTokens)
  // Own content leaves room for the overlap plus the joining newline.
  const ownMaxChars = Math.max(1, charsFor(maxTokens - overlapTokens) - (overlapTokens > 0 ? 1 : 0))
  const pieces = buildPieces(input, ownMaxChars)

  if (!pieces.length) return []

  const packed = packTurns(groupTurns(pieces), Math.min(charsFor(minTokens), ownMaxChars), ownMaxChars)
  const meetingLanguage = toTextLanguage(input.meetingLanguage)

  return packed.map((own, index) =>
    toDraft(own, overlapLines(packed[index - 1], overlapTokens > 0 ? charsFor(overlapTokens) : 0), index, meetingLanguage)
  )
}
