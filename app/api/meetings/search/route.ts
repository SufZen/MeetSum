import { NextResponse } from "next/server"

import { requireAppAccess, jsonError } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

/**
 * GET /api/meetings/search — Search meetings by title, participant, or tag.
 *
 * Query params:
 *   q      — Search query (searches title, participant names)
 *   tag    — Filter by tag
 *   status — Filter by status (completed, processing, error)
 *   source — Filter by source (google_meet, manual_upload, etc.)
 *   limit  — Max results (default: 20, max: 100)
 */
export async function GET(request: Request) {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.api)

  if (rateLimit.blocked) return rateLimit.blocked

  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const url = new URL(request.url)
  const q = url.searchParams.get("q")?.toLowerCase().trim()
  const tag = url.searchParams.get("tag")?.toLowerCase().trim()
  const status = url.searchParams.get("status")?.trim()
  const source = url.searchParams.get("source")?.trim()
  const rawLimit = Number(url.searchParams.get("limit") ?? 20)
  const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 20 : rawLimit, 1), 100)

  if (!q && !tag && !status && !source) {
    return jsonError("At least one search parameter (q, tag, status, source) is required", 400)
  }

  try {
    const allMeetings = await meetingRepository.listMeetings({ limit: 500 })

    const results = allMeetings
      .filter((m) => {
        if (q) {
          const titleMatch = m.title.toLowerCase().includes(q)
          const participantMatch =
            (m.participantDetails?.some(
              (p) => p.name.toLowerCase().includes(q) || p.email?.toLowerCase().includes(q)
            ) ?? false) ||
            m.participants.some((p) => p.toLowerCase().includes(q))
          const overviewMatch = m.summary?.overview?.toLowerCase().includes(q) ?? false

          if (!titleMatch && !participantMatch && !overviewMatch) return false
        }

        if (tag && !(m.tags ?? []).some((t) => String(t).toLowerCase() === tag)) {
          return false
        }

        if (status && m.status !== status) return false
        if (source && m.source !== source) return false

        return true
      })
      .slice(0, limit)
      .map((m) => ({
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
    return jsonError(
      error instanceof Error ? error.message : "Search failed",
      500
    )
  }
}
