import { getDatabasePool } from "@/lib/db/client"
import { recordAuditLog } from "@/lib/audit"
import type { MeetingRecord, RepoScope } from "@/lib/meetings/repository"
import { getSystemMeetingRepository } from "@/lib/meetings/store"
import { meetingScopeSql } from "@/lib/meetings/visibility"
import { deliverWebhookEvent } from "@/lib/webhooks/delivery"
import { evaluatePrivacyGate } from "@/lib/integrations/core/privacy"
import { getIntegrationStore } from "@/lib/integrations/core/store"
import type { MeetingIntegrationPrefs } from "@/lib/integrations/core/types"
import { englishQualityWarningText, englishSuggestionText } from "@/lib/integrations/realizeos-text"

/**
 * Outbound payload version. 2 (M9): quality warnings carry
 * `{code, severity, params}` plus English `title`/`message`, and
 * `suggestedRuns` carry the intent code plus English `title`/`description`
 * (dual-emitted for v1 consumers, rendered from the en dictionary).
 */
export const REALIZEOS_PAYLOAD_SCHEMA_VERSION = 2

export function createRealizeOSPayload(meeting: MeetingRecord | undefined) {
  if (!meeting) {
    throw new Error("Meeting is required for RealizeOS export")
  }

  return {
    schemaVersion: REALIZEOS_PAYLOAD_SCHEMA_VERSION,
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
    processing: {
      aiRuns: (meeting.aiRuns ?? []).map((run) => ({
        id: run.id,
        provider: run.provider,
        task: run.task,
        status: run.status,
        model: run.model,
        latencyMs: run.latencyMs,
        confidence: run.confidence,
        metadata: run.metadata,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        error: run.error,
      })),
      qualityWarnings: (meeting.qualityWarnings ?? []).map((warning) => ({
        ...warning,
        ...englishQualityWarningText(warning),
      })),
      googleContext: (meeting.meetConferenceRecords ?? []).map((record) => ({
        id: record.id,
        conferenceRecordName: record.conferenceRecordName,
        calendarEventId: record.calendarEventId,
        startTime: record.startTime,
        artifacts: record.artifacts.map((artifact) => ({
          id: artifact.id,
          type: artifact.artifactType,
          state: artifact.state,
          driveFileId: artifact.driveFileId,
          documentName: artifact.documentName,
        })),
      })),
    },
    suggestedRuns: (meeting.suggestedAgentRuns ?? []).map((run) => {
      const intent = typeof run.payload.intent === "string" ? run.payload.intent : ""

      return {
        id: run.id,
        target: run.target,
        status: run.status,
        intent,
        ...englishSuggestionText(intent),
      }
    }),
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

/** Raised when a meeting/export does not exist in the caller's workspace. */
export class RealizeOSExportNotFoundError extends Error {
  constructor(message = "RealizeOS export not found") {
    super(message)
    this.name = "RealizeOSExportNotFoundError"
  }
}

/** Raised when a private meeting has no owner opt-in for external pushes (R11). */
export class RealizeOSPrivateMeetingError extends Error {
  readonly code = "private_meeting_not_opted_in"
  readonly status = 403

  constructor() {
    super("Private meeting: the owner has not allowed external exports")
    this.name = "RealizeOSPrivateMeetingError"
  }
}

type PrivacyPrefs = Pick<MeetingIntegrationPrefs, "allowPrivatePush" | "allowPrivateSetByUserId">

/**
 * M10 R11: RealizeOS goes through the same M8 privacy gate as every other
 * push (`evaluatePrivacyGate`, origin `manual`): a private meeting (or one
 * with an unknown visibility) leaves only when its current owner opted in
 * per meeting (`meeting_integration_prefs.allow_private_push`). Evaluated at
 * send time, so a meeting made private after the export was queued is caught.
 */
export async function assertRealizeOSPrivacy(
  meeting: Pick<MeetingRecord, "id" | "visibility" | "ownerUserId">,
  workspaceId: string,
  getPrefs: (workspaceId: string, meetingId: string) => Promise<PrivacyPrefs | undefined> = async (ws, id) =>
    (await getIntegrationStore()).getPrefs(ws, id)
): Promise<void> {
  const facts = { visibility: meeting.visibility, ...(meeting.ownerUserId ? { ownerUserId: meeting.ownerUserId } : {}) }

  // Shared meetings never need the prefs lookup.
  if (evaluatePrivacyGate({ facts, origin: "manual" }).allowed) return

  const prefs = await getPrefs(workspaceId, meeting.id)
  const decision = evaluatePrivacyGate({ facts, origin: "manual", ...(prefs ? { prefs } : {}) })

  if (!decision.allowed) throw new RealizeOSPrivateMeetingError()
}

export async function exportMeetingToRealizeOS(options: {
  meetingId?: string
  workspaceId: string
  suggestionId?: string
  contextId?: string
}) {
  if (!options.meetingId) {
    throw new Error("meetingId is required for RealizeOS export")
  }

  if (!options.workspaceId) {
    throw new Error("workspaceId is required for RealizeOS export")
  }

  // The workspace's system repository returns nothing for another
  // workspace's meeting, so an export can never read across tenants.
  const meeting = await getSystemMeetingRepository(options.workspaceId).getMeeting(
    options.meetingId
  )

  if (!meeting) {
    throw new RealizeOSExportNotFoundError(`Meeting not found: ${options.meetingId}`)
  }

  try {
    await assertRealizeOSPrivacy(meeting, options.workspaceId)
  } catch (error) {
    if (error instanceof RealizeOSPrivateMeetingError && options.suggestionId) {
      await updateSuggestedRun(options.suggestionId, { status: "failed", lastError: error.code })
    }
    throw error
  }

  if (options.suggestionId) {
    await updateSuggestedRun(options.suggestionId, { status: "queued" })
  }

  const { baseUrl } = configuredEndpoint()

  if (!baseUrl) {
    throw new Error("REALIZEOS_API_URL is not configured")
  }

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
      workspaceId: options.workspaceId,
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
      workspaceId: options.workspaceId,
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
    workspaceId: options.workspaceId,
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
    workspaceId: options.workspaceId,
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

/**
 * Exports the caller may see (suggested_agent_runs has no workspace column;
 * the meeting it belongs to decides, under the caller's visibility scope —
 * the payload carries the meeting's full intelligence, so a private meeting's
 * exports are visible only to those who can see the meeting).
 */
export async function listRealizeOSExports(
  scope: RepoScope,
  options: { meetingId?: string; limit?: number } = {}
) {
  if (process.env.MEETSUM_STORAGE !== "postgres") return []

  const values: unknown[] = ["realizeos"]
  const clauses = ["s.target = $1", meetingScopeSql(scope, "m", values)]

  if (options.meetingId) {
    values.push(options.meetingId)
    clauses.push(`s.meeting_id = $${values.length}`)
  }

  values.push(Math.min(Math.max(Math.trunc(options.limit ?? 25), 1), 100))
  const result = await getDatabasePool().query(
    `
      select s.id, s.meeting_id, s.target, s.payload, s.response, s.status,
             s.last_error, s.created_at
      from suggested_agent_runs s
      join meetings m on m.id = s.meeting_id
      where ${clauses.join(" and ")}
      order by s.created_at desc
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

/** Re-sends an export; one whose meeting the caller cannot see is "not found". */
export async function retryRealizeOSExport(scope: RepoScope, id: string) {
  if (process.env.MEETSUM_STORAGE !== "postgres") {
    throw new Error("RealizeOS export retry requires Postgres storage")
  }

  const values: unknown[] = [id]
  const visible = meetingScopeSql(scope, "m", values)
  const result = await getDatabasePool().query(
    `
      select s.id, s.meeting_id
      from suggested_agent_runs s
      join meetings m on m.id = s.meeting_id
      where s.id = $1 and s.target = 'realizeos' and ${visible}
      limit 1
    `,
    values
  )
  const row = result.rows[0] as { id?: string; meeting_id?: string } | undefined

  if (!row?.id || !row.meeting_id) throw new RealizeOSExportNotFoundError()

  return exportMeetingToRealizeOS({
    meetingId: row.meeting_id,
    workspaceId: scope.workspaceId,
    suggestionId: row.id,
  })
}
