import { getDatabasePool } from "@/lib/db/client"
import { recordAuditLog } from "@/lib/audit"
import { meetingRepository } from "@/lib/meetings/store"
import { deliverWebhookEvent } from "@/lib/webhooks/delivery"

export function createRealizeOSPayload(meeting: Awaited<ReturnType<typeof meetingRepository.getMeeting>>) {
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

function configuredEndpoint() {
  const baseUrl = process.env.REALIZEOS_API_URL
  const path = process.env.REALIZEOS_MEETING_CONTEXT_PATH ?? "/api/meeting-context"

  return {
    configured: Boolean(baseUrl),
    baseUrl,
    path,
    authConfigured: Boolean(process.env.REALIZEOS_API_KEY),
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

  const { baseUrl } = configuredEndpoint()

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
    await recordAuditLog({
      action: "realizeos.export.failed",
      targetType: "meeting",
      targetId: options.meetingId,
      metadata: {
        suggestionId: options.suggestionId,
        responseStatus: response.status,
        response: responseBody,
      },
    })
    await deliverWebhookEvent({
      eventName: "realizeos.export.failed",
      data: {
        meetingId: options.meetingId,
        suggestionId: options.suggestionId,
        responseStatus: response.status,
        error: message,
      },
    })
    throw new Error(message)
  }

  if (options.suggestionId) {
    await updateSuggestedRun(options.suggestionId, {
      status: "sent",
      response: { status: response.status, body: responseBody },
    })
  }
  await recordAuditLog({
    action: "realizeos.export.sent",
    targetType: "meeting",
    targetId: options.meetingId,
    metadata: {
      suggestionId: options.suggestionId,
      responseStatus: response.status,
      response: responseBody,
    },
  })
  await deliverWebhookEvent({
    eventName: "realizeos.export.sent",
    data: {
      meetingId: options.meetingId,
      suggestionId: options.suggestionId,
      responseStatus: response.status,
    },
  })

  return {
    status: "sent",
    meetingId: options.meetingId,
    responseStatus: response.status,
    response: responseBody,
  }
}

export async function getRealizeOSStatus() {
  const endpoint = configuredEndpoint()

  return {
    id: "realizeos",
    label: "RealizeOS",
    configured: endpoint.configured,
    baseUrl: endpoint.baseUrl ? new URL(endpoint.baseUrl).origin : undefined,
    path: endpoint.path,
    authConfigured: endpoint.authConfigured,
    mode: "approval-gated-export",
    message: endpoint.configured
      ? "RealizeOS export endpoint is configured. Meeting exports require approval before sending."
      : "REALIZEOS_API_URL is not configured. Add it on the VPS before sending exports.",
  }
}

export async function listRealizeOSExports(options: { meetingId?: string; limit?: number } = {}) {
  if (process.env.MEETSUM_STORAGE !== "postgres") return []

  const values: unknown[] = ["realizeos"]
  const clauses = ["target = $1"]

  if (options.meetingId) {
    values.push(options.meetingId)
    clauses.push(`meeting_id = $${values.length}`)
  }

  values.push(Math.min(Math.max(Math.trunc(options.limit ?? 25), 1), 100))
  const result = await getDatabasePool().query(
    `
      select id, meeting_id, target, payload, response, status, last_error, created_at
      from suggested_agent_runs
      where ${clauses.join(" and ")}
      order by created_at desc
      limit $${values.length}
    `,
    values
  )

  return result.rows.map((row) => ({
    id: String(row.id),
    meetingId: String(row.meeting_id),
    target: "realizeos",
    payload: row.payload ?? {},
    response: row.response ?? {},
    status: String(row.status),
    lastError: row.last_error ? String(row.last_error) : undefined,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString(),
  }))
}

export async function retryRealizeOSExport(id: string) {
  if (process.env.MEETSUM_STORAGE !== "postgres") {
    throw new Error("RealizeOS export retry requires Postgres storage")
  }

  const result = await getDatabasePool().query(
    `
      select id, meeting_id
      from suggested_agent_runs
      where id = $1 and target = 'realizeos'
      limit 1
    `,
    [id]
  )
  const row = result.rows[0] as { id?: string; meeting_id?: string } | undefined

  if (!row?.id || !row.meeting_id) throw new Error("RealizeOS export not found")

  return exportMeetingToRealizeOS({
    meetingId: row.meeting_id,
    suggestionId: row.id,
  })
}
