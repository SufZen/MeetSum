import { timingSafeEqual } from "node:crypto"

import { createTokenCache } from "@/lib/capture/token-cache"
import {
  CaptureConfigError,
  RecordingDownloadError,
  type CaptureAdapter,
  type CaptureEvent,
  type RecordingDownload,
  type WebhookValidation,
} from "@/lib/capture/types"
import type { CreateMeetingInput } from "@/lib/meetings/repository"

export const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0"

/**
 * Microsoft Graph change notification payload.
 */
type GraphNotification = {
  value: Array<{
    subscriptionId?: string
    changeType?: string
    resource?: string
    clientState?: string
    tenantId?: string
    lifecycleEvent?: string
    subscriptionExpirationDateTime?: string
    resourceData?: {
      "@odata.type"?: string
      "@odata.id"?: string
      id?: string
    }
  }>
}

function isGraphNotification(body: unknown): body is GraphNotification {
  return (
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as { value?: unknown }).value)
  )
}

/**
 * Graph resource paths we are willing to call `/content` on. Anything else
 * (absolute URLs, traversal, query strings) is rejected so a notification
 * can never steer the bearer token to another endpoint.
 */
const TEAMS_RESOURCE_PATTERN =
  /^(users|communications|me)\/[A-Za-z0-9_\-.:@=,'()%/]+$/

export function isValidTeamsRecordingResource(resource: unknown): resource is string {
  return (
    typeof resource === "string" &&
    resource.length <= 1024 &&
    TEAMS_RESOURCE_PATTERN.test(resource) &&
    !resource.split("/").some((segment) => segment === ".." || segment === ".") &&
    !resource.includes("//")
  )
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)

  return left.length === right.length && timingSafeEqual(left, right)
}

export function getTeamsClientState(env: NodeJS.ProcessEnv = process.env) {
  return env.TEAMS_WEBHOOK_CLIENT_STATE?.trim() ?? ""
}

/**
 * Validates `clientState` on every notification of a Graph batch.
 */
export function validateTeamsClientState(body: string): WebhookValidation {
  const clientState = getTeamsClientState()

  if (!clientState) {
    return { valid: false, reason: "TEAMS_WEBHOOK_CLIENT_STATE not configured" }
  }

  // Validate clientState on EVERY notification in the batch, not just the
  // first — otherwise an attacker could prepend one valid entry and smuggle
  // unvalidated notifications behind it.
  try {
    const parsed = JSON.parse(body) as GraphNotification
    const notifications = Array.isArray(parsed?.value) ? parsed.value : []

    if (notifications.length === 0) {
      return { valid: false, reason: "Teams notification batch is empty" }
    }

    if (
      notifications.some(
        (entry) =>
          typeof entry?.clientState !== "string" ||
          !safeEqual(entry.clientState, clientState)
      )
    ) {
      return { valid: false, reason: "Invalid clientState in Teams notification" }
    }
  } catch {
    return { valid: false, reason: "Invalid JSON in Teams webhook body" }
  }

  return { valid: true }
}

function graphCredentials(env: NodeJS.ProcessEnv = process.env) {
  const tenantId = env.AZURE_TENANT_ID?.trim()
  const clientId = env.AZURE_CLIENT_ID?.trim()
  const clientSecret = env.AZURE_CLIENT_SECRET?.trim()

  if (!tenantId || !clientId || !clientSecret) {
    throw new CaptureConfigError(
      "Microsoft Graph access requires AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET"
    )
  }

  return { tenantId, clientId, clientSecret }
}

/** Client-credentials Graph token, cached until shortly before expiry. */
const graphTokenCache = createTokenCache(async () => {
  const { tenantId, clientId, clientSecret } = graphCredentials()
  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
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
    throw new RecordingDownloadError("teams", res.status, `Azure AD token failed: ${res.status}`)
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number }

  if (!data.access_token) {
    throw new RecordingDownloadError("teams", 502, "Azure AD token response had no access_token")
  }

  return { token: data.access_token, expiresInSeconds: data.expires_in }
})

export async function getGraphAccessToken(): Promise<string> {
  return graphTokenCache.get()
}

/** Test hook / 401 recovery: forget the cached Graph token. */
export function resetGraphTokenCache() {
  graphTokenCache.clear()
}

/** Authenticated Graph request; refreshes the token once on 401. */
export async function graphFetch(path: string, init: RequestInit = {}) {
  const url = path.startsWith("https://") ? path : `${GRAPH_BASE_URL}/${path.replace(/^\//, "")}`
  const send = async () =>
    fetch(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${await getGraphAccessToken()}`,
      },
    })
  let res = await send()

  if (res.status === 401) {
    await res.body?.cancel().catch(() => {})
    resetGraphTokenCache()
    res = await send()
  }

  return res
}

function toCaptureEvent(
  notification: GraphNotification["value"][number]
): CaptureEvent | null {
  if (notification.changeType !== "created") return null
  if (!isValidTeamsRecordingResource(notification.resource)) return null

  const resource = notification.resource

  return {
    platform: "teams",
    eventType: "recording.available",
    externalId: notification.resourceData?.id ?? resource,
    title: "Teams Meeting",
    startedAt: new Date().toISOString(),
    participants: [],
    recordingUrl: resource,
    recordingMimeType: "video/mp4",
    metadata: {
      subscriptionId: notification.subscriptionId,
      resource,
      changeType: notification.changeType,
      tenantId: notification.tenantId,
    },
  }
}

export const teamsCaptureAdapter: CaptureAdapter = {
  platform: "teams",

  validateWebhook(
    _headers: Record<string, string>,
    body: string
  ): WebhookValidation {
    return validateTeamsClientState(body)
  },

  parseEvent(body: unknown): CaptureEvent | null {
    return teamsCaptureAdapter.parseEvents?.(body)[0] ?? null
  },

  parseEvents(body: unknown): CaptureEvent[] {
    if (!isGraphNotification(body)) return []

    const seen = new Set<string>()

    return body.value
      .map((notification) =>
        notification && typeof notification === "object"
          ? toCaptureEvent(notification)
          : null
      )
      .filter((event): event is CaptureEvent => {
        if (!event || seen.has(event.externalId)) return false
        seen.add(event.externalId)
        return true
      })
  },

  toMeetingInput(event: CaptureEvent): CreateMeetingInput {
    return {
      title: event.title,
      source: "teams",
      language: "auto",
      startedAt: event.startedAt,
      participants: event.participants,
      externalSource: "teams",
      externalId: event.externalId,
    }
  },

  async downloadRecording(event: CaptureEvent): Promise<RecordingDownload> {
    if (!isValidTeamsRecordingResource(event.recordingUrl)) {
      throw new CaptureConfigError("Teams event has no valid recording resource")
    }

    const res = await graphFetch(`${event.recordingUrl}/content`, {
      redirect: "follow",
    })

    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {})
      throw new RecordingDownloadError("teams", res.ok ? 502 : res.status)
    }

    const declaredLength = Number(res.headers.get("content-length") ?? "")
    const contentType =
      res.headers.get("content-type")?.split(";")[0].trim() ||
      event.recordingMimeType ||
      "video/mp4"

    return {
      body: res.body,
      filename: `teams-${event.externalId.replace(/[^\w.-]+/g, "_").slice(0, 120)}.mp4`,
      contentType:
        contentType === "application/octet-stream"
          ? (event.recordingMimeType ?? "video/mp4")
          : contentType,
      sizeBytes:
        Number.isFinite(declaredLength) && declaredLength > 0
          ? declaredLength
          : undefined,
    }
  },
}
