import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import {
  buildGoogleSyncPlan,
  type GoogleSyncSource,
} from "@/lib/google/workspace"
import { resolveRequestWorkspaceSubject } from "@/lib/google/request-subject"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import { createPlatformEvent } from "@/lib/platform/events"

const eventBySource: Record<
  GoogleSyncSource,
  Parameters<typeof createPlatformEvent>[0]
> = {
  calendar: "google.calendar.event_changed",
  gmail: "google.gmail.thread_matched",
  drive: "google.drive.recording_found",
}

export const POST = withAuthz<{ source: string }>(
  "integrations:manage",
  async (request, ctx, { params }) => {
    const { source } = await params
    const body = (await request.json().catch(() => ({}))) as {
      subject?: string
    }

    if (!["calendar", "gmail", "drive"].includes(source)) {
      return jsonError("Unsupported Google source", 400)
    }

    const resolved = resolveRequestWorkspaceSubject(ctx, body.subject, {
      requireWorkspaceSubject: true,
    })

    if ("response" in resolved) return resolved.response

    const { subject } = resolved

    const syncSource = source as GoogleSyncSource

    if (syncSource === "drive") {
      return jsonError(
        "Drive auto-import is disabled. Use /api/google/drive/recordings to review candidates and /api/google/drive/import to import selected files.",
        409
      )
    }

    const syncItem = buildGoogleSyncPlan(subject).find(
      (item) => item.source === syncSource
    )
    const job = await enqueueMeetSumJob(`google.${syncSource}.poll`, {
      subject,
      source: syncSource,
      workspaceId: ctx.workspace.id,
    })

    return NextResponse.json({
      sync: {
        ...syncItem,
        status: "queued",
      },
      job,
      event: createPlatformEvent(
        eventBySource[syncSource],
        { subject, source: syncSource },
        { workspaceId: ctx.workspace.id }
      ),
    })
  }
)
