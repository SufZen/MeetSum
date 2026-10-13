import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { resolveRequestWorkspaceSubject } from "@/lib/google/request-subject"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"

export const POST = withAuthz("integrations:manage", async (request, ctx) => {
  const body = (await request.json().catch(() => ({}))) as {
    subject?: string
  }
  const resolved = resolveRequestWorkspaceSubject(ctx, body.subject, {
    requireWorkspaceSubject: true,
  })

  if ("response" in resolved) return resolved.response

  const { subject } = resolved
  const jobs = await Promise.all([
    enqueueMeetSumJob("google.calendar.poll", {
      subject,
      source: "calendar",
      workspaceId: ctx.workspace.id,
    }),
  ])

  return NextResponse.json(
    {
      jobs,
      skipped: {
        drive:
          "Drive media import is manual-only. Use /api/google/drive/recordings and /api/google/drive/import.",
        gmail: "Gmail context sync is deferred.",
      },
    },
    { status: 202 }
  )
})
