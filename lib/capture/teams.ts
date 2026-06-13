import type {
  CaptureAdapter,
  CaptureEvent,
  RecordingDownload,
  WebhookValidation,
} from "@/lib/capture/types"
import type { CreateMeetingInput } from "@/lib/meetings/repository"

/**
 * Microsoft Graph change notification payload.
 */
type GraphNotification = {
  value: Array<{
    subscriptionId: string
    changeType: "created" | "updated" | "deleted"
    resource: string
    clientState?: string
    resourceData?: {
      "@odata.type": string
      "@odata.id": string
      id: string
    }
  }>
}

/**
 * Graph subscription validation request.
 */
type GraphValidation = {
  validationToken: string
}

function isGraphValidation(body: unknown): body is GraphValidation {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { validationToken?: unknown }).validationToken === "string"
  )
}

function isGraphNotification(body: unknown): body is GraphNotification {
  return (
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as { value?: unknown }).value)
  )
}

/**
 * Get a Microsoft Graph access token using client credentials flow.
 */
async function getGraphAccessToken(): Promise<string> {
  const tenantId = process.env.AZURE_TENANT_ID ?? ""
  const clientId = process.env.AZURE_CLIENT_ID ?? ""
  const clientSecret = process.env.AZURE_CLIENT_SECRET ?? ""

  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    }
  )

  if (!res.ok) {
    throw new Error(`Azure AD token failed: ${res.status}`)
  }

  const data = (await res.json()) as { access_token: string }
  return data.access_token
}

export const teamsCaptureAdapter: CaptureAdapter = {
  platform: "teams",

  validateWebhook(
    _headers: Record<string, string>,
    body: string
  ): WebhookValidation {
    const clientState = process.env.TEAMS_WEBHOOK_CLIENT_STATE ?? ""

    if (!clientState) {
      return { valid: false, reason: "TEAMS_WEBHOOK_CLIENT_STATE not configured" }
    }

    // Validate clientState on EVERY notification in the batch, not just the
    // first — otherwise an attacker could prepend one valid entry and smuggle
    // unvalidated notifications behind it.
    try {
      const parsed = JSON.parse(body) as GraphNotification
      const notifications = parsed.value ?? []

      if (notifications.length === 0) {
        return { valid: false, reason: "Teams notification batch is empty" }
      }

      if (notifications.some((entry) => entry.clientState !== clientState)) {
        return { valid: false, reason: "Invalid clientState in Teams notification" }
      }
    } catch {
      return { valid: false, reason: "Invalid JSON in Teams webhook body" }
    }

    return { valid: true }
  },

  parseEvent(body: unknown): CaptureEvent | null {
    if (!isGraphNotification(body)) return null

    const notification = body.value[0]

    if (!notification) return null

    // We're interested in created recording files
    if (notification.changeType !== "created") return null

    return {
      platform: "teams",
      eventType: "recording.available",
      externalId: notification.resourceData?.id ?? notification.resource,
      title: `Teams Meeting`,
      startedAt: new Date().toISOString(),
      participants: [],
      recordingUrl: notification.resource,
      recordingMimeType: "video/mp4",
      metadata: {
        subscriptionId: notification.subscriptionId,
        resource: notification.resource,
        changeType: notification.changeType,
      },
    }
  },

  toMeetingInput(event: CaptureEvent): CreateMeetingInput {
    return {
      title: event.title,
      source: "teams",
      language: "auto",
      startedAt: event.startedAt,
      participants: event.participants,
    }
  },

  async downloadRecording(event: CaptureEvent): Promise<RecordingDownload> {
    if (!event.recordingUrl) {
      throw new Error("No recording resource in Teams event")
    }

    const token = await getGraphAccessToken()
    const graphUrl = `https://graph.microsoft.com/v1.0/${event.recordingUrl}/content`

    const res = await fetch(graphUrl, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      throw new Error(`Teams recording download failed: ${res.status}`)
    }

    const buffer = Buffer.from(await res.arrayBuffer())

    return {
      buffer,
      filename: `teams-${event.externalId}.mp4`,
      contentType: event.recordingMimeType ?? "video/mp4",
      sizeBytes: buffer.byteLength,
    }
  },
}
