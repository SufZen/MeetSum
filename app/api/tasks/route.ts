import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { toRepoScope, withAuthz } from "@/lib/auth/authz"
import { parseTaskQuery, validationMessage } from "@/lib/tasks/api"
import { InvalidTaskCursorError, listTasks } from "@/lib/tasks/store"

/**
 * GET /api/tasks — action items across every meeting the caller can see
 * (M5 B6). Query: `scope=mine|all`, `status=open|done|overdue|all`,
 * `roomId`, `meetingId`, `ownerUserId`, `dueFrom`, `dueTo`, `q`, `sort`,
 * `cursor`, `limit` (≤ 100).
 */
export const GET = withAuthz("meeting:read", async (request, ctx) => {
  const parsed = parseTaskQuery(new URL(request.url).searchParams)

  if (!parsed.success) return jsonError(validationMessage(parsed.error), 400)

  try {
    const page = await listTasks(toRepoScope(ctx), parsed.data, { repository: ctx.meetings })

    return NextResponse.json(page)
  } catch (error) {
    if (error instanceof InvalidTaskCursorError) return jsonError("Invalid cursor", 400)
    throw error
  }
})
