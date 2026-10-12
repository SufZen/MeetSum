import { NextResponse } from "next/server"

import { auditActor, creatorUserId } from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import type { MeetingListSortMode } from "@/lib/meetings/repository"
import { parseCreateMeetingInput } from "@/lib/meetings/validation"
import { createPlatformEvent } from "@/lib/platform/events"
import {
  getAppSettings,
  resolveDefaultMeetingLanguage,
} from "@/lib/settings/app-settings"

const pageSizes = [5, 10, 20] as const
const sortModes = ["smart", "recent", "oldest", "title", "status"] as const

function parseLimit(value: string | null) {
  const numeric = Number(value ?? 5)

  return pageSizes.includes(numeric as (typeof pageSizes)[number]) ? numeric : 5
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

export const GET = withAuthz("meeting:read", async (request, ctx) => {
  const searchParams = new URL(request.url).searchParams
  const query = searchParams.get("query")?.trim()
  const status = searchParams.get("status")?.trim() || "all"
  const limit = parseLimit(searchParams.get("limit"))
  const offset = parseOffset(searchParams.get("offset"))
  const sort = parseSort(searchParams.get("sort"))
  const result = await ctx.meetings.listMeetingsPage({
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
})

/**
 * Applies the workspace default meeting language when the payload does not
 * name one (`meetingLanguageMode`, M2 settings wiring).
 */
function withDefaultLanguage(payload: unknown, defaultLanguage: string) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload
  }

  const body = payload as Record<string, unknown>
  const language = typeof body.language === "string" ? body.language.trim() : ""

  return language ? body : { ...body, language: defaultLanguage }
}

export const POST = withAuthz("meeting:create", async (request, ctx) => {
  const settings = await getAppSettings(ctx.workspace.id)
  let input

  try {
    input = parseCreateMeetingInput(
      withDefaultLanguage(
        await request.json(),
        resolveDefaultMeetingLanguage(settings)
      )
    )
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Invalid meeting payload",
      400
    )
  }

  const meeting = await ctx.meetings.createMeeting({
    ...input,
    ownerUserId: creatorUserId(ctx),
    visibility: settings.defaultMeetingVisibility,
  })
  await recordAuditLog({
    ...auditActor(ctx),
    action: "meeting.created",
    targetType: "meeting",
    targetId: meeting.id,
    metadata: {
      source: meeting.source,
      visibility: settings.defaultMeetingVisibility,
    },
  })
  const event = createPlatformEvent("meeting.created", {
    meetingId: meeting.id,
  })

  return NextResponse.json({ meeting, event }, { status: 201 })
})
