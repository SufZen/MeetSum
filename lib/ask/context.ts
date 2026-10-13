/**
 * Ask prompt context (docs/parity/m6.md, C2).
 *
 * Full-transcript mode (meeting scope, transcript within
 * `MEETSUM_ASK_FULL_TRANSCRIPT_TOKENS`):
 * - system[0] = M5 `buildSharedSystem({language, sharedContext})` over
 *   `formatTranscriptForPrompt` (cached; byte-identical to the summary
 *   prefix for the same meeting and language), system[1] = the fixed Ask
 *   instructions;
 * - intelligence items are `[aN]` lines in the final user message.
 *
 * Retrieval mode:
 * - system[0] = fixed instructions + style guide (cached);
 * - then the same user's thread history (cache flag on its last message);
 * - the final user message holds `<passages>` then `<question>`.
 *
 * Cache rule: no cached block ever contains this request's question. The
 * question is always the last thing in the last message.
 */
import { getStyleGuide } from "@/lib/ai/prompts/style-guide"
import { buildSharedSystem } from "@/lib/ai/llm/system"
import type { LlmChatMessage } from "@/lib/ai/llm/types"
import { quoteOf, type AliasEntry, type AliasMap } from "@/lib/ask/citations"
import type { AskLanguage } from "@/lib/ask/messages"
import { askInstructions } from "@/lib/ask/prompt"
import { sanitizeAttribute, sanitizeLine, sanitizeName, sanitizeQuestion } from "@/lib/ask/sanitize"
import { formatNumericDate } from "@/lib/i18n/format"
import { estimateTokens, formatTimestamp, formatTranscriptForPrompt } from "@/lib/intelligence/transcript-format"
import type { MeetingRecord, MeetingSpeaker, TranscriptSegment } from "@/lib/meetings/repository"
import type { RetrievedPassage, SearchMode } from "@/lib/search/types"
import { getTaskTimeZone } from "@/lib/tasks/time-zone"

export type HistoryTurn = { role: "user" | "assistant"; content: string }

export type RetrievalSummary = {
  mode: SearchMode
  chunkIds: string[]
  scores: number[]
  topSimilarity: number | null
  lexicalHits: number
}

export type AskContext = {
  mode: "full_transcript" | "retrieval"
  searchMode: SearchMode
  system: { text: string; cache?: boolean }[]
  messages: LlmChatMessage[]
  aliases: AliasMap
  /** Ids and scores only (persisted as `chat_messages.retrieval`). */
  retrieval: RetrievalSummary | null
}

const MARKERS = /\s*\[\s*[sa]\d+(?:\s*[,;]\s*[sa]\d+)*\s*\]/gi

/** `DD.MM.YYYY` in the task/workspace zone (Asia/Jerusalem unless configured). */
export function formatPassageDate(iso: string, timeZone: string = getTaskTimeZone()): string {
  return formatNumericDate(iso, timeZone)
}

/**
 * Prior turns of the same user's thread: the last `turns` exchanges,
 * starting with a user message, alternating roles. Old citation markers are
 * removed (their aliases belonged to an earlier request).
 */
export function historyMessages(history: readonly HistoryTurn[], turns: number): LlmChatMessage[] {
  if (turns <= 0) return []

  const recent = history
    .map((turn) => ({ role: turn.role, content: turn.content.replace(MARKERS, "").trim() }))
    .filter((turn) => turn.content)
    .slice(-turns * 2)
  const messages: LlmChatMessage[] = []

  for (const turn of recent) {
    const previous = messages.at(-1)

    if (!previous && turn.role === "assistant") continue
    if (previous?.role === turn.role) previous.content += `\n\n${turn.content}`
    else messages.push({ role: turn.role, content: turn.role === "user" ? sanitizeQuestion(turn.content) : turn.content })
  }
  // The model's last turn must be followed by our new user message.
  if (messages.at(-1)?.role === "user") messages.pop()
  if (messages.length) messages[messages.length - 1] = { ...messages[messages.length - 1], cache: true }
  return messages
}

function questionBlock(question: string): string {
  return `<question>\n${sanitizeQuestion(question)}\n</question>`
}

function finalMessage(passages: string, question: string): LlmChatMessage {
  return { role: "user", content: passages ? `${passages}\n\n${questionBlock(question)}` : questionBlock(question) }
}

function speakerOf(segment: TranscriptSegment, speakers: Map<string, MeetingSpeaker>): string | undefined {
  const speaker = segment.speakerId ? speakers.get(segment.speakerId) : undefined
  const name = speaker?.displayName?.trim() || segment.speaker?.trim() || speaker?.label

  return name || undefined
}

/** Usable transcript segments, as the M5 summary pipeline selects them. */
export function promptSegments(meeting: Pick<MeetingRecord, "transcript">): TranscriptSegment[] {
  return (meeting.transcript ?? []).filter((segment) => segment.text?.trim())
}

/** Token estimate of the meeting's full prompt transcript. */
export function fullTranscriptTokenEstimate(meeting: Pick<MeetingRecord, "transcript" | "speakers">): number {
  const segments = promptSegments(meeting)

  return segments.length ? formatTranscriptForPrompt(segments, meeting.speakers ?? []).estimatedTokens : 0
}

export function buildFullTranscriptContext(input: {
  meeting: MeetingRecord
  language: AskLanguage
  question: string
  history?: readonly HistoryTurn[]
  historyTurns?: number
}): AskContext {
  const { meeting, language } = input
  const speakers = meeting.speakers ?? []
  const transcript = formatTranscriptForPrompt(promptSegments(meeting), speakers)
  const speakerById = new Map(speakers.map((speaker) => [speaker.id, speaker]))
  const aliases: AliasMap = {}

  for (const [alias, segment] of transcript.aliasToSegment) {
    aliases[alias] = {
      alias,
      meetingId: meeting.id,
      meetingTitle: meeting.title,
      segmentId: segment.id,
      startMs: segment.startMs,
      kind: "transcript",
      speakerName: speakerOf(segment, speakerById),
      quote: quoteOf(segment.text),
    }
  }

  const items = (meeting.intelligence?.items ?? []).filter((item) => item.text?.trim())
  const itemLines = items.map((item, index) => {
    const alias = `a${index + 1}`
    const ref = item.refs?.[0]

    aliases[alias] = {
      alias,
      meetingId: meeting.id,
      meetingTitle: meeting.title,
      ...(ref ? { segmentId: ref.segmentId, startMs: ref.startMs } : {}),
      kind: "item",
      quote: quoteOf(item.text),
    }
    return `[${alias}] (${item.kind}) ${sanitizeLine(item.text)}`
  })
  const passages = itemLines.length
    ? [
        "<passages>",
        `<passage meeting="${sanitizeAttribute(meeting.title)}" date="${formatPassageDate(meeting.startedAt)}" kind="item">`,
        ...itemLines,
        "</passage>",
        "</passages>",
      ].join("\n")
    : ""

  return {
    mode: "full_transcript",
    searchMode: "empty",
    system: [
      { text: buildSharedSystem({ language, sharedContext: transcript.text }), cache: true },
      { text: askInstructions(language) },
    ],
    messages: [...historyMessages(input.history ?? [], input.historyTurns ?? 0), finalMessage(passages, input.question)],
    aliases,
    retrieval: null,
  }
}

type AliasState = { aliases: AliasMap; segmentAlias: Map<string, string>; nextS: number; nextA: number }

/** Speaker of the `index`-th segment of a chunk ("דנה: …" turn lines). */
function passageSpeaker(passage: RetrievedPassage, index: number): string | undefined {
  const { chunk } = passage

  if (chunk.speakerIds.length === 1) return passage.speakerNames[chunk.speakerIds[0]]

  const offset = chunk.segmentOffsets[index]

  if (offset === undefined) return undefined

  const lineStart = chunk.text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1
  const match = chunk.text.slice(lineStart, offset).match(/^([^:\n]{1,80}):\s/)

  return match?.[1]?.trim() || undefined
}

function renderPassage(passage: RetrievedPassage, state: AliasState): string {
  const { chunk } = passage
  const base = { meetingId: chunk.meetingId, meetingTitle: passage.meetingTitle }
  const lines: string[] = []

  if (chunk.kind === "transcript") {
    chunk.segmentIds.forEach((segmentId, index) => {
      const text = passage.segmentTexts[segmentId]

      if (!text?.trim()) return

      const startMs = chunk.segmentStartMs[index] ?? chunk.startMs ?? 0
      const speakerName = passageSpeaker(passage, index)
      let alias = state.segmentAlias.get(segmentId)

      if (!alias) {
        alias = `s${state.nextS++}`
        state.segmentAlias.set(segmentId, alias)
        state.aliases[alias] = { ...base, alias, segmentId, startMs, kind: "transcript", speakerName, quote: quoteOf(text) }
      }
      lines.push(`[${alias} ${formatTimestamp(startMs)} ${sanitizeName(speakerName ?? "?") || "?"}] ${sanitizeLine(text)}`)
    })
  }
  // A transcript chunk is cited only through its own live segments: when
  // none of them still exist (edited/deleted since indexing), skip it rather
  // than fall back to the stale indexed chunk text.
  if (chunk.kind === "transcript") return lines.length ? wrapPassage(passage, lines) : ""
  if (!lines.length && chunk.text.trim()) {
    const alias = `a${state.nextA++}`
    const segmentId = chunk.segmentIds[0]
    const startMs = chunk.startMs ?? chunk.segmentStartMs[0]
    const entry: AliasEntry = {
      ...base,
      alias,
      ...(segmentId ? { segmentId } : {}),
      ...(startMs !== undefined ? { startMs } : {}),
      kind: chunk.kind,
      quote: quoteOf(chunk.text),
    }

    state.aliases[alias] = entry
    lines.push(`[${alias}] ${sanitizeLine(chunk.text)}`)
  }
  if (!lines.length) return ""

  return wrapPassage(passage, lines)
}

function wrapPassage(passage: RetrievedPassage, lines: string[]): string {
  return [
    `<passage meeting="${sanitizeAttribute(passage.meetingTitle)}" date="${formatPassageDate(passage.meetingStartedAt)}" kind="${passage.chunk.kind}">`,
    ...lines,
    "</passage>",
  ].join("\n")
}

export function buildRetrievalContext(input: {
  passages: readonly RetrievedPassage[]
  searchMode: SearchMode
  topSimilarity: number | null
  lexicalHits: number
  language: AskLanguage
  question: string
  history?: readonly HistoryTurn[]
  historyTurns?: number
  budgetTokens: number
  maxPassages: number
}): AskContext {
  const state: AliasState = { aliases: {}, segmentAlias: new Map(), nextS: 1, nextA: 1 }
  const blocks: string[] = []
  const used: RetrievedPassage[] = []
  let tokens = 0

  for (const passage of input.passages) {
    if (used.length >= input.maxPassages) break

    // Render into a scratch state so a passage over budget leaves no aliases.
    const scratch: AliasState = {
      aliases: { ...state.aliases },
      segmentAlias: new Map(state.segmentAlias),
      nextS: state.nextS,
      nextA: state.nextA,
    }
    const block = renderPassage(passage, scratch)
    const cost = estimateTokens(block)

    if (!block || (used.length > 0 && tokens + cost > input.budgetTokens)) continue
    Object.assign(state, scratch)
    blocks.push(block)
    used.push(passage)
    tokens += cost
  }

  const passages = blocks.length ? ["<passages>", ...blocks, "</passages>"].join("\n") : ""

  return {
    mode: "retrieval",
    searchMode: input.searchMode,
    system: [{ text: `${askInstructions(input.language)}\n\n${getStyleGuide(input.language)}`, cache: true }],
    messages: [...historyMessages(input.history ?? [], input.historyTurns ?? 0), finalMessage(passages, input.question)],
    aliases: state.aliases,
    retrieval: {
      mode: input.searchMode,
      chunkIds: used.map((passage) => passage.chunk.id),
      scores: used.map((passage) => Math.round(passage.score * 1e4) / 1e4),
      topSimilarity: input.topSimilarity,
      lexicalHits: input.lexicalHits,
    },
  }
}
