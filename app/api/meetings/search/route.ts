import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import type { MeetingRecord } from "@/lib/meetings/repository"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { searchContextFrom } from "@/lib/search/context"
import { MAX_QUERY_CHARS } from "@/lib/search/filters"
import { searchMeetingIds } from "@/lib/search/service"
import type { SearchFilters } from "@/lib/search/types"

/**
 * GET /api/meetings/search — Search meetings by title, participant, or tag.
 * Only meetings visible to the caller are searched. M6: delegates to the
 * hybrid search (`searchWorkspace`); params and response shape unchanged.
 * Prefer `GET /api/search`.
 *
 * Query params:
 *   q      — Search query (titles, participants, summaries, transcripts)
 *   tag    — Filter by tag
 *   status — Filter by status (completed, processing, error)
 *   source — Filter by source (google_meet, manual_upload, etc.)
 *   limit  — Max results (default: 20, max: 100)
 */
export const GET = withAuthz("meeting:read", async (request, ctx) => {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.search)

  if (rateLimit.blocked) return rateLimit.blocked

  const url = new URL(request.url)
  const q = url.searchParams.get("q")?.toLowerCase().trim()
  const tag = url.searchParams.get("tag")?.toLowerCase().trim()
  const status = url.searchParams.get("status")?.trim()
  const source = url.searchParams.get("source")?.trim()
  const rawLimit = Number(url.searchParams.get("limit") ?? 20)
  const limit = Math.min(
    Math.max(Number.isNaN(rawLimit) ? 20 : rawLimit, 1),
    100
  )

  if (!q && !tag && !status && !source) {
    return jsonError(
      "At least one search parameter (q, tag, status, source) is required",
      400
    )
  }

  if (q && q.length > MAX_QUERY_CHARS) {
    return jsonError(`q must be at most ${MAX_QUERY_CHARS} characters`, 400)
  }

  try {
    let meetings: MeetingRecord[]

    if (!q && !tag && !source) {
      // Status-only: a plain scoped listing.
      meetings = await ctx.meetings.listMeetings({ status, limit, sort: "recent" })
    } else {
      const filters: SearchFilters = {
        ...(tag ? { tags: [tag] } : {}),
        ...(source ? { sources: [source] } : {}),
      }
      const ids = await searchMeetingIds(searchContextFrom(ctx), q ?? "", {
        limit: status ? 100 : limit,
        filters,
      })
      const loaded = ids.length
        ? await Promise.all(
            ids.map((id) => ctx.meetings.getMeeting(id, { includeTranscript: false }))
          )
        : q
          ? // Nothing indexed matches yet (e.g. new meetings): the scoped
            // repository lookup, narrowed by the same filters.
            (await ctx.meetings.searchMeetings(q, { limit: 100 })).filter(
              (meeting) =>
                (!tag || (meeting.tags ?? []).some((value) => String(value).toLowerCase() === tag)) &&
                (!source || meeting.source === source)
            )
          : []

      meetings = loaded.filter(
        (meeting): meeting is MeetingRecord =>
          Boolean(meeting) && (!status || meeting?.status === status)
      )
    }

    const results = meetings.slice(0, limit).map((m) => ({
      id: m.id,
      title: m.title,
      startedAt: m.startedAt,
      status: m.status,
      source: m.source,
      language: m.language,
      overview: m.summary?.overview?.slice(0, 200) ?? "",
      participantCount:
        m.participantDetails?.length || m.participants.length || 0,
      tags: m.tags ?? [],
      isFavorite: m.isFavorite ?? false,
    }))

    return NextResponse.json(
      {
        query: { q, tag, status, source },
        total: results.length,
        meetings: results,
      },
      { headers: rateLimit.headers }
    )
  } catch (error) {
    console.error("[meetings/search] failed:", error instanceof Error ? error.name : "unknown")

    return jsonError("Search failed", 500)
  }
})
