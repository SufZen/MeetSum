/**
 * Synthetic retrieval corpus loader (docs/parity/m6.md, B8; owner: Package B).
 * `tests/fixtures/search/corpus.he.json` → MeetingRecords plus gold queries.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"

import type { MeetingIntelligence, MeetingTag } from "@/lib/intelligence/types"
import type { MeetingRecord, MeetingSpeaker, TranscriptSegment } from "@/lib/meetings/repository"
import type { SearchFilters } from "@/lib/search/types"

export const DEFAULT_CORPUS_PATH = path.join("tests", "fixtures", "search", "corpus.he.json")

export const EVAL_CATEGORIES = [
  "prefix",
  "plural_finals",
  "gershayim",
  "niqqud",
  "latin",
  "names",
  "numbers",
  "short_tokens",
  "filters",
  "paraphrase",
] as const

export type EvalCategory = (typeof EVAL_CATEGORIES)[number]

/** Orthographic categories with CI thresholds. */
export const ORTHOGRAPHIC_CATEGORIES: readonly EvalCategory[] = [
  "prefix",
  "plural_finals",
  "gershayim",
  "niqqud",
  "latin",
  "short_tokens",
]

type RawMeeting = {
  id: string
  title: string
  startedAt: string
  language: string
  source: string
  meetingType: string
  rooms: { id: string; name: string }[]
  tags: string[]
  segments: [string, string][]
  overview: string
  decisions: { text: string; refs: string[] }[]
  actionItems: { title: string; owner: string; ref: string }[]
}

export type EvalQuery = {
  id: string
  category: EvalCategory
  q: string
  filters?: SearchFilters
  /** Relevant when a hit is in `meetingId` and touches one of `segmentIds` (any segment when empty). */
  gold: { meetingId: string; segmentIds: string[] }
}

export type EvalCorpus = {
  workspaceId: string
  meetings: MeetingRecord[]
  queries: EvalQuery[]
  /** sha256 of the corpus file bytes. */
  sha256: string
}

const SEGMENT_MS = 6000

function toMeeting(raw: RawMeeting, workspaceId: string): MeetingRecord {
  const names = [...new Set(raw.segments.map(([name]) => name))]
  const speakers: MeetingSpeaker[] = names.map((name, index) => ({
    id: `${raw.id}_spk${index + 1}`,
    meetingId: raw.id,
    label: `SPEAKER_${index}`,
    displayName: name,
    mappingStatus: "confirmed",
    source: "asr",
    talkTimeMs: 0,
    wordCount: 0,
    segmentCount: raw.segments.filter(([speaker]) => speaker === name).length,
  }))
  let turn = -1
  const transcript: TranscriptSegment[] = raw.segments.map(([name, text], index) => {
    if (index === 0 || raw.segments[index - 1][0] !== name) turn += 1

    return {
      id: `${raw.id}_s${String(index + 1).padStart(2, "0")}`,
      speaker: name,
      speakerId: `${raw.id}_spk${names.indexOf(name) + 1}`,
      turnIndex: turn,
      startMs: index * SEGMENT_MS,
      endMs: (index + 1) * SEGMENT_MS,
      text,
    }
  })
  const segment = (ref: string) => transcript.find((item) => item.id === `${raw.id}_${ref}`)
  const actionItems = raw.actionItems.map((item, index) => ({
    id: `${raw.id}_a${index + 1}`,
    title: item.title,
    owner: item.owner,
    status: "open" as const,
    sourceStartMs: segment(item.ref)?.startMs,
    sourceSegmentId: segment(item.ref)?.id,
  }))
  const intelligence = {
    overview: raw.overview,
    decisions: raw.decisions.map((decision) => decision.text),
    actionItems: [],
    risks: [],
    openQuestions: [],
    commitments: [],
    followUpDraft: "",
    timestampedQuotes: [],
    tags: raw.tags as MeetingTag[],
    languageMetadata: {
      primaryLanguage: raw.language === "mixed" ? "he" : raw.language,
      secondaryLanguages: [],
      segmentLanguages: [],
      confidence: 1,
      mixedLanguage: raw.language === "mixed",
    },
    version: 2,
    meetingType: raw.meetingType,
    items: raw.decisions.map((decision, index) => ({
      id: `${raw.id}_i${index + 1}`,
      kind: "decision" as const,
      text: decision.text,
      refs: decision.refs.flatMap((ref) => {
        const found = segment(ref)

        return found ? [{ segmentId: found.id, startMs: found.startMs }] : []
      }),
    })),
  } as MeetingIntelligence

  return {
    id: raw.id,
    title: raw.title,
    source: raw.source as MeetingRecord["source"],
    language: raw.language,
    status: "completed",
    retention: "audio",
    startedAt: raw.startedAt,
    participants: names,
    tags: raw.tags as MeetingTag[],
    contexts: raw.rooms.map((room) => ({ ...room, createdAt: "2026-01-01T00:00:00.000Z" })),
    speakers,
    transcript,
    summary: { overview: raw.overview, decisions: raw.decisions.map((decision) => decision.text), actionItems },
    intelligence,
    workspaceId,
    visibility: "workspace",
    transcriptVersion: 1,
    durationMs: transcript.length * SEGMENT_MS,
  }
}

export function parseCorpus(text: string): EvalCorpus {
  const raw = JSON.parse(text) as {
    workspaceId: string
    meetings: RawMeeting[]
    queries: { id: string; category: EvalCategory; q: string; filters?: SearchFilters; gold: { meetingId: string; segments: string[] } }[]
  }

  return {
    workspaceId: raw.workspaceId,
    meetings: raw.meetings.map((meeting) => toMeeting(meeting, raw.workspaceId)),
    queries: raw.queries.map((query) => ({
      id: query.id,
      category: query.category,
      q: query.q,
      ...(query.filters ? { filters: query.filters } : {}),
      gold: {
        meetingId: query.gold.meetingId,
        segmentIds: query.gold.segments.map((ref) => `${query.gold.meetingId}_${ref}`),
      },
    })),
    sha256: createHash("sha256").update(text).digest("hex"),
  }
}

export function loadCorpus(file = DEFAULT_CORPUS_PATH): EvalCorpus {
  return parseCorpus(readFileSync(file, "utf8"))
}
