/**
 * Intelligence and meta chunks (docs/parity/m6.md, A3; owner: Package A).
 * Pure and deterministic.
 *
 * - meta: title, `DD.MM.YYYY`, participant and speaker names, tags, rooms,
 *   meeting type.
 * - summary: overview plus template sections, split at the max.
 * - item: IntelligenceV2 items (decision, risk, open_question, commitment,
 *   next_step), packed to the max; `segment_ids` = refs, `start_ms` = first
 *   ref. Legacy intelligence without items falls back to its arrays.
 * - action_item: one per item (title, owner, due text); `source_id` = id.
 * - chapter: title plus summary, with its start.
 * `content_hash = sha256(kind + "\0" + text)`.
 */
import { formatNumericDate } from "@/lib/i18n/format"
import { estimateTokens } from "@/lib/intelligence/transcript-format"
import type { MeetingIntelligence, SummaryItem, SummaryItemKind } from "@/lib/intelligence/types"
import type { ActionItem, MeetingRecord } from "@/lib/meetings/repository"
import { chunkContentHash, chunkOptionsFromEnv, splitTextByTokens } from "@/lib/search/chunker"
import { detectTextLanguage, normalizeForIndex } from "@/lib/search/hebrew-normalize"
import type { ChunkDraft, ChunkKind } from "@/lib/search/types"

/** Meeting dates in the meta chunk are local to the product's home time zone. */
const META_TIME_ZONE = "Asia/Jerusalem"

const ITEM_KINDS: readonly SummaryItemKind[] = ["decision", "risk", "open_question", "commitment", "next_step"]

type Ref = { segmentId: string; startMs: number }

type DraftInput = {
  kind: ChunkKind
  chunkIndex: number
  text: string
  sourceId?: string
  refs?: { ref: Ref; offset: number }[]
  startMs?: number
  endMs?: number
}

function draft(input: DraftInput): ChunkDraft {
  const { norm, stems } = normalizeForIndex(input.text)
  const refs = input.refs ?? []

  return {
    kind: input.kind,
    chunkIndex: input.chunkIndex,
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    segmentIds: refs.map((entry) => entry.ref.segmentId),
    segmentStartMs: refs.map((entry) => entry.ref.startMs),
    segmentOffsets: refs.map((entry) => entry.offset),
    overlapCount: 0,
    speakerIds: [],
    ...(input.startMs !== undefined ? { startMs: input.startMs } : {}),
    ...(input.endMs !== undefined ? { endMs: input.endMs } : {}),
    language: detectTextLanguage(input.text),
    text: input.text,
    textNorm: norm,
    textStem: stems,
    tokenEstimate: estimateTokens(input.text),
    contentHash: chunkContentHash(input.kind, input.text),
  }
}

function formatMetaDate(iso: string): string | undefined {
  return formatNumericDate(iso, META_TIME_ZONE) || undefined
}

function unique(values: (string | undefined)[]): string[] {
  return [...new Set(values.map((value) => value?.replace(/\s+/g, " ").trim()).filter((value): value is string => Boolean(value)))]
}

function metaChunk(meeting: MeetingRecord): ChunkDraft {
  const participants = meeting.participantDetails?.length
    ? unique(meeting.participantDetails.flatMap((participant) => [participant.name, participant.email]))
    : unique(meeting.participants)
  const speakers = unique((meeting.speakers ?? []).map((spk) => spk.displayName || spk.label))
  const lines = [
    meeting.title,
    formatMetaDate(meeting.startedAt),
    participants.join(", "),
    speakers.join(", "),
    unique(meeting.tags ?? meeting.intelligence?.tags ?? []).join(", "),
    unique((meeting.contexts ?? []).map((context) => context.name)).join(", "),
    meeting.intelligence?.meetingType,
  ]
    .map((line) => line?.trim())
    .filter(Boolean)

  return draft({ kind: "meta", chunkIndex: 0, text: lines.join("\n") })
}

function summaryChunks(meeting: MeetingRecord, maxTokens: number): ChunkDraft[] {
  const intelligence = meeting.intelligence
  const paragraphs = [
    intelligence?.overview || meeting.summary?.overview,
    ...(intelligence?.sections ?? []).map((section) => {
      const text = section.text?.trim()

      if (!text) return undefined
      return section.title?.trim() ? `${section.title.trim()}: ${text}` : text
    }),
  ]
    .map((paragraph) => paragraph?.trim())
    .filter((paragraph): paragraph is string => Boolean(paragraph))

  if (!paragraphs.length) return []

  return packParagraphs(paragraphs, maxTokens).map((text, chunkIndex) => draft({ kind: "summary", chunkIndex, text }))
}

/** Joins paragraphs with blank lines into pieces of at most `maxTokens`. */
function packParagraphs(paragraphs: string[], maxTokens: number): string[] {
  const pieces = paragraphs.flatMap((paragraph) => splitTextByTokens(paragraph, maxTokens).map((piece) => piece.text))
  const chunks: string[] = []
  let current = ""

  for (const piece of pieces) {
    const candidate = current ? `${current}\n\n${piece}` : piece

    if (current && estimateTokens(candidate) > maxTokens) {
      chunks.push(current)
      current = piece
    } else {
      current = candidate
    }
  }
  if (current) chunks.push(current)

  return chunks
}

type ItemLine = { id?: string; text: string; refs: Ref[] }

function itemLines(intelligence: MeetingIntelligence | undefined): ItemLine[] {
  if (!intelligence) return []

  if (intelligence.items?.length) {
    const byKind = (kind: SummaryItemKind) =>
      (intelligence.items ?? []).filter((item: SummaryItem) => item.kind === kind)

    return ITEM_KINDS.flatMap(byKind).map((item) => ({
      id: item.id,
      text: item.text.replace(/\s+/g, " ").trim(),
      refs: item.refs.map((ref) => ({ segmentId: ref.segmentId, startMs: ref.startMs })),
    }))
  }

  return [intelligence.decisions, intelligence.risks, intelligence.openQuestions, intelligence.commitments]
    .flatMap((list) => list ?? [])
    .map((text) => ({ text: text.replace(/\s+/g, " ").trim(), refs: [] }))
}

function itemChunks(meeting: MeetingRecord, maxTokens: number): ChunkDraft[] {
  const lines = itemLines(meeting.intelligence)
    .filter((line) => line.text)
    .flatMap((line) =>
      // An item longer than a chunk keeps its refs on its first piece.
      splitTextByTokens(line.text, maxTokens).map((piece, index) => ({
        id: line.id,
        text: piece.text,
        refs: index === 0 ? line.refs : [],
      }))
    )
  const groups: ItemLine[][] = []
  let current: ItemLine[] = []
  const textOf = (group: ItemLine[]) => group.map((line) => line.text).join("\n")

  for (const line of lines) {
    if (current.length && estimateTokens(textOf([...current, line])) > maxTokens) {
      groups.push(current)
      current = []
    }
    current.push(line)
  }
  if (current.length) groups.push(current)

  return groups.map((group, chunkIndex) => {
    const refs: { ref: Ref; offset: number }[] = []
    let offset = 0

    for (const line of group) {
      for (const ref of line.refs) refs.push({ ref, offset })
      offset += line.text.length + 1
    }

    const ids = unique(group.map((line) => line.id))

    return draft({
      kind: "item",
      chunkIndex,
      text: textOf(group),
      refs,
      ...(ids.length === 1 ? { sourceId: ids[0] } : {}),
      ...(refs.length ? { startMs: refs[0].ref.startMs } : {}),
    })
  })
}

function actionItemChunks(meeting: MeetingRecord): ChunkDraft[] {
  const items: ActionItem[] = meeting.summary?.actionItems ?? meeting.intelligence?.actionItems ?? []

  return items
    .filter((item) => item.title?.trim())
    .map((item, chunkIndex) => {
      const text = unique([item.title, item.owner || item.ownerText, item.dueText || item.dueOn || item.dueDate]).join("\n")
      const ref =
        item.sourceSegmentId && item.sourceStartMs !== undefined
          ? [{ ref: { segmentId: item.sourceSegmentId, startMs: item.sourceStartMs }, offset: 0 }]
          : []

      return draft({
        kind: "action_item",
        chunkIndex,
        text,
        sourceId: item.id,
        refs: ref,
        ...(item.sourceStartMs !== undefined ? { startMs: item.sourceStartMs } : {}),
      })
    })
}

function chapterChunks(meeting: MeetingRecord, maxTokens: number): ChunkDraft[] {
  const chunks: ChunkDraft[] = []

  for (const chapter of meeting.intelligence?.chapters ?? []) {
    const text = [chapter.title, chapter.summary].map((part) => part?.trim()).filter(Boolean).join("\n")

    if (!text) continue
    for (const piece of splitTextByTokens(text, maxTokens)) {
      chunks.push(
        draft({
          kind: "chapter",
          chunkIndex: chunks.length,
          text: piece.text,
          sourceId: chapter.id,
          refs: chapter.startSegmentId ? [{ ref: { segmentId: chapter.startSegmentId, startMs: chapter.startMs }, offset: 0 }] : [],
          startMs: chapter.startMs,
          endMs: chapter.endMs,
        })
      )
    }
  }

  return chunks
}

export function buildChunkSources(meeting: MeetingRecord, opts: { maxTokens?: number } = {}): ChunkDraft[] {
  const maxTokens = Math.max(2, opts.maxTokens ?? chunkOptionsFromEnv().maxTokens)

  return [
    metaChunk(meeting),
    ...summaryChunks(meeting, maxTokens),
    ...itemChunks(meeting, maxTokens),
    ...actionItemChunks(meeting),
    ...chapterChunks(meeting, maxTokens),
  ]
}
