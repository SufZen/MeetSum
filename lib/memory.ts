import type { MeetingTag } from "@/lib/intelligence"
import type { ActionItem, MeetingRecord, TranscriptSegment } from "@/lib/meetings/repository"

export type MemoryMatchSource =
  | "summary"
  | "decision"
  | "action_item"
  | "transcript"
  | "tag"

export type MemoryCitation = {
  meetingId: string
  meetingTitle: string
  source: MemoryMatchSource
  text: string
  segmentId?: string
  actionItemId?: string
  startMs?: number
}

export type MemorySearchResult = {
  id: string
  title: string
  startedAt: string
  status: MeetingRecord["status"]
  tags: string[]
  overview: string
  actionItems: ActionItem[]
  transcriptMatches: TranscriptSegment[]
  matches: MemoryCitation[]
  matchCount: number
}

function tokenize(value: string) {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 2)
}

function textMatches(text: string | undefined, tokens: string[]) {
  if (!text || !tokens.length) return false
  const normalized = text.toLowerCase()

  return tokens.some((token) => normalized.includes(token))
}

function citationBase(meeting: MeetingRecord) {
  return {
    meetingId: meeting.id,
    meetingTitle: meeting.title,
  }
}

function meetingMatches(meeting: MeetingRecord, tokens: string[]) {
  const matches: MemoryCitation[] = []
  const base = citationBase(meeting)

  if (textMatches(meeting.summary?.overview, tokens)) {
    matches.push({
      ...base,
      source: "summary",
      text: meeting.summary?.overview ?? "",
    })
  }

  for (const decision of meeting.summary?.decisions ?? []) {
    if (textMatches(decision, tokens)) {
      matches.push({ ...base, source: "decision", text: decision })
    }
  }

  for (const actionItem of meeting.summary?.actionItems ?? []) {
    if (textMatches(actionItem.title, tokens)) {
      matches.push({
        ...base,
        source: "action_item",
        text: actionItem.title,
        actionItemId: actionItem.id,
        startMs: actionItem.sourceStartMs,
      })
    }
  }

  for (const segment of meeting.transcript ?? []) {
    if (textMatches(segment.text, tokens)) {
      matches.push({
        ...base,
        source: "transcript",
        text: segment.text,
        segmentId: segment.id,
        startMs: segment.startMs,
      })
    }
  }

  for (const tag of meeting.tags ?? []) {
    if (textMatches(tag, tokens)) {
      matches.push({ ...base, source: "tag", text: tag })
    }
  }

  return matches
}

export type MemorySearchFilters = {
  /** Only return results from meetings linked to this room/context */
  roomId?: string
  /** Only return results from meetings with this tag */
  tag?: string
  /** Only return results from meetings that include this participant name (case-insensitive) */
  participant?: string
  /** Only return results from meetings with this primary language */
  language?: string
}

function matchesFilters(
  meeting: MeetingRecord,
  filters: MemorySearchFilters
): boolean {
  if (
    filters.roomId &&
    !meeting.contexts?.some((context) => context.id === filters.roomId)
  ) {
    return false
  }

  if (filters.tag && !(meeting.tags ?? []).includes(filters.tag as MeetingTag)) {
    return false
  }

  if (filters.participant) {
    const lower = filters.participant.toLowerCase()
    const participantNames = [
      ...meeting.participants,
      ...(meeting.participantDetails?.map((p) => p.name) ?? []),
    ]

    if (!participantNames.some((name) => name.toLowerCase().includes(lower))) {
      return false
    }
  }

  if (
    filters.language &&
    meeting.languageMetadata?.primaryLanguage !== filters.language
  ) {
    return false
  }

  return true
}

export function buildMeetingMemoryResults(
  meetings: MeetingRecord[],
  query: string,
  options: { limit?: number; filters?: MemorySearchFilters } = {}
): MemorySearchResult[] {
  const tokens = tokenize(query)
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 8), 20))
  const filters = options.filters ?? {}
  const hasFilters = Object.values(filters).some(Boolean)

  const filtered = hasFilters
    ? meetings.filter((meeting) => matchesFilters(meeting, filters))
    : meetings

  return filtered
    .map((meeting) => {
      const matches = tokens.length ? meetingMatches(meeting, tokens) : []

      return {
        id: meeting.id,
        title: meeting.title,
        startedAt: meeting.startedAt,
        status: meeting.status,
        tags: meeting.tags ?? [],
        overview: meeting.summary?.overview ?? "",
        actionItems: meeting.summary?.actionItems ?? [],
        transcriptMatches: matches
          .filter((match) => match.source === "transcript")
          .slice(0, 3)
          .map((match) => ({
            id: match.segmentId ?? `${meeting.id}_${match.startMs ?? 0}`,
            speaker: "Memory",
            startMs: match.startMs ?? 0,
            endMs: (match.startMs ?? 0) + 1000,
            text: match.text,
          })),
        matches,
        matchCount: matches.length,
      }
    })
    .filter((result) => !tokens.length || result.matchCount > 0)
    .sort((a, b) => b.matchCount - a.matchCount || b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit)
}

export function buildMeetingMemoryAnswer(
  question: string,
  meetings: MeetingRecord[]
) {
  const results = buildMeetingMemoryResults(meetings, question, { limit: 5 })
  const citations = results.flatMap((result) => {
    const firstTranscript = result.matches.find(
      (match) => match.source === "transcript"
    )
    const topMatches = result.matches.slice(0, 3)

    return firstTranscript &&
      !topMatches.some(
        (match) =>
          match.source === "transcript" &&
          match.segmentId === firstTranscript.segmentId
      )
      ? [...topMatches, firstTranscript]
      : topMatches
  })

  if (!results.length) {
    return {
      answer: "No matching meeting memory was found yet.",
      citations: [] as MemoryCitation[],
    }
  }

  const answer = results
    .slice(0, 3)
    .map((result) => {
      const strongest = result.matches[0]
      const summary = result.overview || strongest?.text || "No summary yet."

      return `${result.title}: ${summary}`
    })
    .join("\n\n")

  return {
    answer,
    citations,
  }
}
