import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import type { MeetingListSortMode } from "@/lib/meetings/repository"
import { meetingRepository } from "@/lib/meetings/store"
import { parseCreateMeetingInput } from "@/lib/meetings/validation"
import { createPlatformEvent } from "@/lib/platform/events"

const pageSizes = [5, 10, 20] as const
const sortModes = ["smart", "recent", "oldest", "title", "status"] as const

function parseLimit(value: string | null) {
  const numeric = Number(value ?? 5)

  return pageSizes.includes(numeric as (typeof pageSizes)[number])
    ? numeric
    : 5
}

function parseOffset(value: string | null) {
  const numeric = Number(value ?? 0)

  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0
}

function parseSort(value: string | null): MeetingListSortMode {
  return sortModes.includes(value as MeetingListSortMode)
    ? (value as MeetingListSortMode)
    : "smart"
}

export async function GET(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) {
    return unauthorized
  }

  const searchParams = new URL(request.url).searchParams
  const query = searchParams.get("query")?.trim()
  const status = searchParams.get("status")?.trim() || "all"
  const limit = parseLimit(searchParams.get("limit"))
  const offset = parseOffset(searchParams.get("offset"))
  const sort = parseSort(searchParams.get("sort"))
  const result = await meetingRepository.listMeetingsPage({
    limit,
    offset,
    query,
    status,
    sort,
  })

  return NextResponse.json({
    meetings: result.meetings,
    page: result.page,
  })
}

export async function POST(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) {
    return unauthorized
  }

  let input

  try {
    input = parseCreateMeetingInput(await request.json())
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Invalid meeting payload",
      400
    )
  }

  const meeting = await meetingRepository.createMeeting(input)
  const event = createPlatformEvent("meeting.created", {
    meetingId: meeting.id,
  })

  return NextResponse.json({ meeting, event }, { status: 201 })
}
