/**
 * Reads any stored intelligence blob (legacy v1 or M5 V2, possibly partial)
 * into a complete `MeetingIntelligence` (owner: Package A). Pure and
 * isomorphic: safe in routes, exports and client components.
 *
 * - Every legacy field is present with a safe default.
 * - V2 `items` without legacy arrays fill `decisions/risks/openQuestions/
 *   commitments`; v1 legacy arrays without `items` become items (no refs) so
 *   every bullet has a stable id to comment on.
 * - Malformed entries are dropped, never thrown.
 */
import { normalizeTaskTitle } from "@/lib/meetings/action-item-merge"

import type {
  Chapter,
  ContentLanguage,
  IntelligenceGeneration,
  MeetingIntelligence,
  MeetingLanguageMetadata,
  MeetingTag,
  SmartTask,
  SummaryItem,
  SummaryItemKind,
  SummaryItemRef,
  TemplateSectionOutput,
  TimestampedQuote,
} from "./types"

const MEETING_TAGS: ReadonlySet<MeetingTag> = new Set<MeetingTag>([
  "technical",
  "finance",
  "real-estate",
  "sales",
  "operations",
  "legal",
  "product",
  "follow-up-needed",
  "urgent",
  "hebrew",
  "english",
  "portuguese",
  "spanish",
  "italian",
  "mixed-language",
])

const CONTENT_LANGUAGES: ReadonlySet<ContentLanguage> = new Set<ContentLanguage>([
  "en",
  "he",
  "pt",
  "es",
  "it",
  "mixed",
])

const SUMMARY_ITEM_KINDS: ReadonlySet<SummaryItemKind> = new Set<SummaryItemKind>([
  "decision",
  "risk",
  "open_question",
  "commitment",
  "next_step",
  "section_item",
])

/** Legacy string arrays and the item kind each one derives from. */
const LEGACY_LISTS = [
  ["decisions", "decision"],
  ["risks", "risk"],
  ["openQuestions", "open_question"],
  ["commitments", "commitment"],
] as const satisfies ReadonlyArray<readonly [keyof MeetingIntelligence, SummaryItemKind]>

const MAX_TOPICS = 8

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined

  const trimmed = value.trim()

  return trimmed ? trimmed : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  return value.map(text).filter((entry): entry is string => entry !== undefined)
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

/** SHA-1 hex of a string's UTF-8 bytes (pure; no Node or WebCrypto needed). */
export function sha1Hex(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const bitLength = bytes.length * 8
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6
  const buffer = new Uint8Array(paddedLength)

  buffer.set(bytes)
  buffer[bytes.length] = 0x80

  const view = new DataView(buffer.buffer)

  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(paddedLength - 4, bitLength >>> 0)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) w[index] = view.getUint32(offset + index * 4)
    for (let index = 16; index < 80; index += 1) {
      const value = w[index - 3] ^ w[index - 8] ^ w[index - 14] ^ w[index - 16]

      w[index] = (value << 1) | (value >>> 31)
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4

    for (let index = 0; index < 80; index += 1) {
      let f: number
      let k: number

      if (index < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (index < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }

      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[index]) >>> 0

      e = d
      d = c
      c = (b << 30) | (b >>> 2)
      b = a
      a = temp
    }

    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }

  return [h0, h1, h2, h3, h4].map((value) => value.toString(16).padStart(8, "0")).join("")
}

/**
 * Stable summary item id: `"si_" + sha1(kind + normalizeTaskTitle(text))
 * .slice(0, 12)`. Unchanged text keeps its id across regenerations.
 */
export function summaryItemId(kind: SummaryItemKind, itemText: string): string {
  return `si_${sha1Hex(kind + normalizeTaskTitle(itemText)).slice(0, 12)}`
}

function normalizeRefs(value: unknown): SummaryItemRef[] {
  return records(value).flatMap((ref) => {
    const segmentId = text(ref.segmentId)
    const startMs = finiteNumber(ref.startMs)

    return segmentId && startMs !== undefined && startMs >= 0 ? [{ segmentId, startMs }] : []
  })
}

function normalizeItems(value: unknown): SummaryItem[] {
  const seen = new Set<string>()

  return records(value).flatMap((raw) => {
    const itemText = text(raw.text)
    const kind = raw.kind as SummaryItemKind

    if (!itemText || !SUMMARY_ITEM_KINDS.has(kind)) return []

    const id = text(raw.id) ?? summaryItemId(kind, itemText)

    if (seen.has(id)) return []
    seen.add(id)

    const item: SummaryItem = { id, kind, text: itemText, refs: normalizeRefs(raw.refs) }
    const sectionKey = text(raw.sectionKey)

    if (sectionKey) item.sectionKey = sectionKey
    return [item]
  })
}

function normalizeChapters(value: unknown): Chapter[] {
  const chapters = records(value).flatMap((raw, index) => {
    const title = text(raw.title)
    const startMs = finiteNumber(raw.startMs)

    if (!title || startMs === undefined || startMs < 0) return []

    const endMs = finiteNumber(raw.endMs)

    return [
      {
        id: text(raw.id) ?? `ch_${index + 1}`,
        title,
        summary: text(raw.summary) ?? "",
        startMs,
        endMs: endMs !== undefined && endMs >= startMs ? endMs : startMs,
        startSegmentId: text(raw.startSegmentId) ?? "",
        bullets: stringList(raw.bullets),
      },
    ]
  })

  return chapters.sort((left, right) => left.startMs - right.startMs)
}

function normalizeSections(value: unknown): TemplateSectionOutput[] {
  return records(value).flatMap((raw) => {
    const key = text(raw.key)

    if (!key) return []

    const section: TemplateSectionOutput = { key, itemIds: stringList(raw.itemIds) }
    const title = text(raw.title)
    const body = text(raw.text)

    if (title) section.title = title
    if (body) section.text = body
    return [section]
  })
}

function normalizeActionItems(value: unknown): SmartTask[] {
  return records(value).flatMap((raw, index) => {
    const title = text(raw.title)

    if (!title) return []

    const priority = ["low", "normal", "high", "urgent"].includes(raw.priority as string)
      ? (raw.priority as SmartTask["priority"])
      : "normal"
    const confidence = finiteNumber(raw.confidence)
    const sourceStartMs = finiteNumber(raw.sourceStartMs)

    return [
      {
        ...(raw as Partial<SmartTask>),
        id: text(raw.id) ?? `task_${index}`,
        title,
        status: raw.status === "done" ? "done" : "open",
        priority,
        confidence: confidence === undefined ? 0.5 : Math.min(1, Math.max(0, confidence)),
        sourceQuote: typeof raw.sourceQuote === "string" ? raw.sourceQuote : "",
        sourceStartMs: sourceStartMs !== undefined && sourceStartMs >= 0 ? sourceStartMs : 0,
        kind: raw.kind === "inferred" ? "inferred" : "explicit",
      } satisfies SmartTask,
    ]
  })
}

function normalizeQuotes(value: unknown): TimestampedQuote[] {
  return records(value).flatMap((raw) => {
    const segmentId = text(raw.segmentId)
    const quote = text(raw.text)
    const startMs = finiteNumber(raw.startMs)

    if (!segmentId || !quote || startMs === undefined) return []
    return [{ segmentId, speaker: typeof raw.speaker === "string" ? raw.speaker : "", startMs, text: quote }]
  })
}

function contentLanguage(value: unknown): ContentLanguage | undefined {
  return CONTENT_LANGUAGES.has(value as ContentLanguage) ? (value as ContentLanguage) : undefined
}

function normalizeLanguageMetadata(value: unknown): MeetingLanguageMetadata {
  const raw = isRecord(value) ? value : {}
  const confidence = finiteNumber(raw.confidence)

  return {
    primaryLanguage: contentLanguage(raw.primaryLanguage) ?? "he",
    secondaryLanguages: Array.isArray(raw.secondaryLanguages)
      ? raw.secondaryLanguages
          .map(contentLanguage)
          .filter((language): language is ContentLanguage => language !== undefined)
      : [],
    segmentLanguages: records(raw.segmentLanguages).flatMap((segment) => {
      const segmentId = text(segment.segmentId)
      const language = contentLanguage(segment.language)
      const segmentConfidence = finiteNumber(segment.confidence)

      return segmentId && language
        ? [{ segmentId, language, confidence: segmentConfidence ?? 0 }]
        : []
    }),
    confidence: confidence ?? 0,
    mixedLanguage: raw.mixedLanguage === true,
  }
}

function normalizeGeneration(value: unknown): IntelligenceGeneration | undefined {
  if (!isRecord(value)) return undefined

  const provider = text(value.provider)

  if (!provider) return undefined
  return { ...(value as Partial<IntelligenceGeneration>), provider }
}

export function normalizeIntelligence(raw: unknown): MeetingIntelligence {
  const source = isRecord(raw) ? raw : {}
  let items = normalizeItems(source.items)
  const legacy = Object.fromEntries(
    LEGACY_LISTS.map(([field]) => [field, stringList(source[field])])
  ) as Record<(typeof LEGACY_LISTS)[number][0], string[]>

  if (items.length) {
    for (const [field, kind] of LEGACY_LISTS) {
      if (!legacy[field].length) {
        legacy[field] = items.filter((item) => item.kind === kind).map((item) => item.text)
      }
    }
  } else {
    items = normalizeItems(
      LEGACY_LISTS.flatMap(([field, kind]) =>
        legacy[field].map((entry) => ({ kind, text: entry, refs: [] }))
      )
    )
  }

  const intelligence: MeetingIntelligence = {
    overview: typeof source.overview === "string" ? source.overview : "",
    decisions: legacy.decisions,
    actionItems: normalizeActionItems(source.actionItems),
    risks: legacy.risks,
    openQuestions: legacy.openQuestions,
    commitments: legacy.commitments,
    followUpDraft: typeof source.followUpDraft === "string" ? source.followUpDraft : "",
    timestampedQuotes: normalizeQuotes(source.timestampedQuotes),
    tags: stringList(source.tags).filter((tag): tag is MeetingTag =>
      MEETING_TAGS.has(tag as MeetingTag)
    ),
    languageMetadata: normalizeLanguageMetadata(source.languageMetadata),
    items,
  }

  if (source.version === 2) intelligence.version = 2

  const title = text(source.title)
  const meetingType = text(source.meetingType)
  const topics = stringList(source.topics).slice(0, MAX_TOPICS)
  const chapters = normalizeChapters(source.chapters)
  const sections = normalizeSections(source.sections)
  const generation = normalizeGeneration(source.generation)

  if (title) intelligence.title = title
  if (meetingType) intelligence.meetingType = meetingType
  if (topics.length) intelligence.topics = topics
  if (chapters.length) intelligence.chapters = chapters
  if (sections.length) intelligence.sections = sections
  if (generation) intelligence.generation = generation

  return intelligence
}
