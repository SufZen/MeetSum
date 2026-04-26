import { getDatabasePool } from "@/lib/db/client"
import { meetingRepository } from "@/lib/meetings/store"

function createRealizeOSPayload(meeting: Awaited<ReturnType<typeof meetingRepository.getMeeting>>) {
  if (!meeting) {
    throw new Error("Meeting is required for RealizeOS export")
  }

  return {
    source: "meetsum",
    exportedAt: new Date().toISOString(),
    meeting: {
      id: meeting.id,
      title: meeting.title,
      source: meeting.source,
      status: meeting.status,
      startedAt: meeting.startedAt,
      participants: meeting.participants,
      language: meeting.language,
      languageMetadata: meeting.languageMetadata,
      tags: meeting.tags ?? [],
    },
    summary: meeting.summary,
    intelligence: meeting.intelligence,
    transcript: {
      segmentCount: meeting.transcript?.length ?? 0,
      citations: (meeting.transcript ?? []).slice(0, 20).map((segment) => ({
        id: segment.id,
        speaker: segment.speaker,
        startMs: segment.startMs,
        text: segment.text,
      })),
    },
    actionItems: meeting.summary?.actionItems ?? [],
    contexts: meeting.contexts ?? [],
    mediaAssets: (meeting.mediaAssets ?? []).map((asset) => ({
      id: asset.id,
      filename: asset.filename,
      contentType: asset.contentType,
      retention: asset.retention,
      createdAt: asset.createdAt,
    })),
  }
}

async function updateSuggestedRun(
  id: string,
  patch: {
    status: "queued" | "sent" | "failed"
    response?: Record<string, unknown>
    lastError?: string
  }
) {
  if (process.env.MEETSUM_STORAGE !== "postgres") return

  await getDatabasePool().query(
    `
      update suggested_agent_runs
      set status = $2,
          response = coalesce($3::jsonb, response),
          last_error = $4,
          updated_at = now()
      where id = $1
    `,
    [
      id,
      patch.status,
      patch.response ? JSON.stringify(patch.response) : null,
      patch.lastError ?? null,
    ]
  )
}

export async function exportMeetingToRealizeOS(options: {
  meetingId?: string
  suggestionId?: string
  contextId?: string
}) {
  if (!options.meetingId) {
    throw new Error("meetingId is required for RealizeOS export")
  }

  if (options.suggestionId) {
    await updateSuggestedRun(options.suggestionId, { status: "queued" })
  }

  const baseUrl = process.env.REALIZEOS_API_URL

  if (!baseUrl) {
    throw new Error("REALIZEOS_API_URL is not configured")
  }

  const meeting = await meetingRepository.getMeeting(options.meetingId)
  const payload = {
    ...createRealizeOSPayload(meeting),
    contextId: options.contextId,
  }
  const response = await fetch(
    new URL(
      process.env.REALIZEOS_MEETING_CONTEXT_PATH ?? "/api/meeting-context",
      baseUrl
    ),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.REALIZEOS_API_KEY
          ? { authorization: `Bearer ${process.env.REALIZEOS_API_KEY}` }
          : {}),
      },
      body: JSON.stringify(payload),
    }
  )
  const responseText = await response.text()
  const responseBody = responseText
    ? (() => {
        try {
          return JSON.parse(responseText) as Record<string, unknown>
        } catch {
          return { text: responseText }
        }
      })()
    : {}

  if (!response.ok) {
    const message = `RealizeOS export failed with ${response.status}`

    if (options.suggestionId) {
      await updateSuggestedRun(options.suggestionId, {
        status: "failed",
        response: responseBody,
        lastError: message,
      })
    }
    throw new Error(message)
  }

  if (options.suggestionId) {
    await updateSuggestedRun(options.suggestionId, {
      status: "sent",
      response: { status: response.status, body: responseBody },
    })
  }

  return {
    status: "sent",
    meetingId: options.meetingId,
    responseStatus: response.status,
    response: responseBody,
  }
}
