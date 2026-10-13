import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { buildMeetingMemoryResults } from "@/lib/memory"
import type { MemoryCitation, MemoryMatchSource, MemorySearchFilters, MemorySearchResult } from "@/lib/memory"
import type { MeetingRecord } from "@/lib/meetings/repository"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { searchContextFrom, searchRateLimitKey, searchRateLimitUnavailable } from "@/lib/search/context"
import { SearchUnavailableError } from "@/lib/search/errors"
import { MAX_QUERY_CHARS, TEXT_LANGUAGES } from "@/lib/search/filters"
import { searchWorkspace } from "@/lib/search/service"
import type { ChunkKind, SearchFilters, SearchHit, TextLanguage } from "@/lib/search/types"
import { getLogger } from "@/lib/log"

const log = getLogger({ component: "memory/search" })

/**
 * GET /api/memory/search — legacy memory search (`{results}`), deprecated in
 * favour of `GET /api/search`. M6: adapted from hybrid-search groups.
 */
const DEPRECATION_HEADERS = {
  Deprecation: "true",
  Link: '</api/search>; rel="successor-version"',
}

const SOURCE_BY_KIND: Record<ChunkKind, MemoryMatchSource> = {
  transcript: "transcript",
  summary: "summary",
  chapter: "summary",
  item: "decision",
  action_item: "action_item",
  meta: "tag",
}

function toCitation(meeting: MeetingRecord, hit: SearchHit): MemoryCitation {
  const source = SOURCE_BY_KIND[hit.kind]

  return {
    meetingId: meeting.id,
    meetingTitle: meeting.title,
    source,
    text: hit.snippet,
    ...(source === "transcript" && hit.segmentId ? { segmentId: hit.segmentId } : {}),
    ...(hit.startMs !== undefined ? { startMs: hit.startMs } : {}),
  }
}

export const GET = withAuthz("meeting:read", async (request, ctx) => {
  const limitKey = searchRateLimitKey(ctx)

  if (!limitKey) return searchRateLimitUnavailable()

  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.search, limitKey)

  if (rateLimit.blocked) return rateLimit.blocked

  const headers = { ...rateLimit.headers, ...DEPRECATION_HEADERS }
  const searchParams = new URL(request.url).searchParams
  const query = (searchParams.get("query")?.trim() ?? "").slice(0, MAX_QUERY_CHARS)
  const limit = Math.max(
    1,
    Math.min(Math.trunc(Number(searchParams.get("limit") ?? 20)) || 20, 50)
  )

  const filters: MemorySearchFilters = {}
  if (searchParams.get("roomId")) filters.roomId = searchParams.get("roomId")!
  if (searchParams.get("tag")) filters.tag = searchParams.get("tag")!
  if (searchParams.get("participant")) {
    filters.participant = searchParams.get("participant")!
  }
  if (searchParams.get("language"))
    filters.language = searchParams.get("language")!

  if (!query) {
    const meetings = await ctx.meetings.listMeetings({ limit })

    return NextResponse.json(
      { results: buildMeetingMemoryResults(meetings, query, { limit, filters }) },
      { headers }
    )
  }

  const searchFilters: SearchFilters = {
    ...(filters.roomId ? { roomIds: [filters.roomId] } : {}),
    ...(filters.tag ? { tags: [filters.tag] } : {}),
    ...(filters.participant ? { participants: [filters.participant] } : {}),
    ...(filters.language && TEXT_LANGUAGES.includes(filters.language as TextLanguage)
      ? { languages: [filters.language as TextLanguage] }
      : {}),
  }

  try {
    const response = await searchWorkspace(searchContextFrom(ctx), {
      q: query,
      filters: searchFilters,
      group: "meeting",
      limit: Math.min(limit, 25),
      hitsPerMeeting: 10,
    }, { signal: request.signal })
    const results = await Promise.all(
      (response.groups ?? []).map(async (group): Promise<MemorySearchResult | null> => {
        const meeting = await ctx.meetings.getMeeting(group.meeting.id, { includeTranscript: false })

        if (!meeting) return null

        const matches = group.hits.map((hit) => toCitation(meeting, hit))

        return {
          id: meeting.id,
          title: meeting.title,
          startedAt: meeting.startedAt,
          status: meeting.status,
          tags: meeting.tags ?? [],
          overview: meeting.summary?.overview ?? "",
          actionItems: meeting.summary?.actionItems ?? [],
          transcriptMatches: group.hits
            .filter((hit) => hit.kind === "transcript")
            .slice(0, 3)
            .map((hit) => ({
              id: hit.segmentId ?? `${meeting.id}_${hit.startMs ?? 0}`,
              speaker: hit.speakerName ?? "Memory",
              startMs: hit.startMs ?? 0,
              endMs: hit.endMs ?? (hit.startMs ?? 0) + 1000,
              text: hit.snippet,
            })),
          matches,
          matchCount: matches.length,
        }
      })
    )

    return NextResponse.json(
      { results: results.filter((result): result is MemorySearchResult => result !== null) },
      { headers }
    )
  } catch (error) {
    if (error instanceof SearchUnavailableError) {
      return NextResponse.json({ error: "Search unavailable" }, { status: 503, headers })
    }
    log.error({ errorName: error instanceof Error ? error.name : "unknown" }, "[memory/search] failed:")

    return NextResponse.json({ error: "Search failed" }, { status: 500, headers })
  }
})
