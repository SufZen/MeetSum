import { NextResponse } from "next/server"

import { requireAppAccess } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

/**
 * GET /api/meetings/timeline — Calendar-style meeting aggregation.
 *
 * Query params:
 *   from  — ISO date string (inclusive, default: 30 days ago)
 *   to    — ISO date string (exclusive, default: now)
 *   roomId — Filter by room/context ID
 *   groupBy — "day" | "week" | "month" (default: "day")
 */
export async function GET(request: Request) {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.api)

  if (rateLimit.blocked) return rateLimit.blocked

  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const url = new URL(request.url)
  const now = new Date()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000)

  const fromParam = url.searchParams.get("from")
  const toParam = url.searchParams.get("to")
  const roomId = url.searchParams.get("roomId") ?? undefined
  const groupBy = url.searchParams.get("groupBy") ?? "day"

  const from = fromParam ? new Date(fromParam) : thirtyDaysAgo
  const to = toParam ? new Date(toParam) : now

  // Fetch all meetings (filtered by room if provided)
  const allMeetings = roomId
    ? await meetingRepository.listMeetingsByContext(roomId)
    : await meetingRepository.listMeetings({ limit: 500 })

  // Filter to date range
  const meetings = allMeetings.filter((m) => {
    const date = new Date(m.startedAt)
    return date >= from && date < to
  })

  // Build timeline entries
  const entries = meetings.map((m) => ({
    id: m.id,
    title: m.title,
    startedAt: m.startedAt,
    status: m.status,
    source: m.source,
    language: m.language,
    participantCount:
      m.participantDetails?.length || m.participants.length || 0,
    hasTranscript: (m.transcript?.length ?? 0) > 0,
    hasSummary: Boolean(m.summary?.overview),
    actionItemCount: m.summary?.actionItems.length ?? 0,
    openActionItems:
      m.summary?.actionItems.filter((a) => a.status === "open").length ?? 0,
    tags: m.tags ?? [],
    contextId: m.contexts?.[0],
  }))

  // Group by period
  const groups = new Map<string, typeof entries>()

  for (const entry of entries) {
    const key = getGroupKey(entry.startedAt, groupBy)
    const group = groups.get(key) ?? []

    group.push(entry)
    groups.set(key, group)
  }

  const timeline = [...groups.entries()]
    .map(([period, items]) => ({
      period,
      meetingCount: items.length,
      meetings: items.sort(
        (a, b) =>
          new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
      ),
    }))
    .sort((a, b) => a.period.localeCompare(b.period))

  // Aggregate stats
  const stats = {
    totalMeetings: entries.length,
    completedMeetings: entries.filter((e) => e.status === "completed").length,
    totalActionItems: entries.reduce((sum, e) => sum + e.actionItemCount, 0),
    openActionItems: entries.reduce((sum, e) => sum + e.openActionItems, 0),
    meetingsWithTranscript: entries.filter((e) => e.hasTranscript).length,
    meetingsWithSummary: entries.filter((e) => e.hasSummary).length,
    uniqueParticipants: new Set(
      allMeetings
        .filter((m) => {
          const d = new Date(m.startedAt)
          return d >= from && d < to
        })
        .flatMap(
          (m) =>
            m.participantDetails?.map((p) => p.email ?? p.name) ??
            m.participants
        )
    ).size,
  }

  return NextResponse.json(
    {
      from: from.toISOString(),
      to: to.toISOString(),
      groupBy,
      roomId: roomId ?? null,
      stats,
      timeline,
    },
    { headers: rateLimit.headers }
  )
}

function getGroupKey(dateStr: string, groupBy: string): string {
  const date = new Date(dateStr)

  if (groupBy === "month") {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`
  }

  if (groupBy === "week") {
    // ISO week start (Monday)
    const d = new Date(date)
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
    return d.toISOString().split("T")[0]
  }

  // day (default)
  return date.toISOString().split("T")[0]
}
