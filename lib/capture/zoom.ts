import { createHmac, timingSafeEqual } from "node:crypto"

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

type ZoomRecordingFile = {
  id?: string
  meeting_id?: string
  recording_start?: string
  recording_end?: string
  file_type?: string
  file_extension?: string
  file_size?: number
  download_url?: string
  recording_type?: string
  status?: string
}

/**
 * Zoom webhook event payload (recording.completed).
 */
type ZoomRecordingEvent = {
  event: string
  payload: {
    object: {
      uuid: string
      id: number
      topic: string
      start_time: string
      duration: number
      participant_count?: number
      recording_files?: ZoomRecordingFile[]
    }
  }
}

/**
 * Zoom URL validation challenge payload.
 */
type ZoomChallenge = {
  event: "endpoint.url_validation"
  payload: {
    plainToken: string
  }
}

export function isZoomChallenge(body: unknown): body is ZoomChallenge {
  if (typeof body !== "object" || body === null) return false

  const candidate = body as {
    event?: unknown
    payload?: { plainToken?: unknown }
  }

  return (
    candidate.event === "endpoint.url_validation" &&
    typeof candidate.payload?.plainToken === "string"
  )
}

function isRecordingEvent(body: unknown): body is ZoomRecordingEvent {
  const candidate = body as ZoomRecordingEvent | null

  return (
    typeof body === "object" &&
    body !== null &&
    candidate?.event === "recording.completed" &&
    typeof candidate.payload?.object?.uuid === "string"
  )
}

export function getZoomWebhookSecret(env: NodeJS.ProcessEnv = process.env) {
  return env.ZOOM_WEBHOOK_SECRET?.trim() ?? ""
}

/**
 * Verify Zoom webhook HMAC-SHA256 signature.
 */
export function verifyZoomSignature(
  headers: Record<string, string>,
  body: string,
  secret: string
): boolean {
  const timestamp = headers["x-zm-request-timestamp"] ?? ""
  const signature = headers["x-zm-signature"] ?? ""

  if (!secret || !timestamp || !signature) return false

  const message = `v0:${timestamp}:${body}`
  const expected = `v0=${createHmac("sha256", secret).update(message).digest("hex")}`

  const expectedBuf = Buffer.from(expected)
  const signatureBuf = Buffer.from(signature)

  return (
    expectedBuf.length === signatureBuf.length &&
    timingSafeEqual(expectedBuf, signatureBuf)
  )
}

/**
 * Handle Zoom URL validation challenge. Requires ZOOM_WEBHOOK_SECRET — an
 * HMAC with an empty key would let anyone validate the endpoint.
 */
export function handleZoomChallenge(body: ZoomChallenge): {
  plainToken: string
  encryptedToken: string
} {
  const secret = getZoomWebhookSecret()

  if (!secret) {
    throw new CaptureConfigError("ZOOM_WEBHOOK_SECRET not configured")
  }

  return {
    plainToken: body.payload.plainToken,
    encryptedToken: createHmac("sha256", secret)
      .update(body.payload.plainToken)
      .digest("hex"),
  }
}

function zoomCredentials(env: NodeJS.ProcessEnv = process.env) {
  const accountId = env.ZOOM_ACCOUNT_ID?.trim()
  const clientId = env.ZOOM_CLIENT_ID?.trim()
  const clientSecret = env.ZOOM_CLIENT_SECRET?.trim()

  if (!accountId || !clientId || !clientSecret) {
    throw new CaptureConfigError(
      "Zoom recording download requires ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET"
    )
  }

  return { accountId, clientId, clientSecret }
}

/** Server-to-Server OAuth token, cached until shortly before expiry. */
const zoomTokenCache = createTokenCache(async () => {
  const { accountId, clientId, clientSecret } = zoomCredentials()
  const res = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "account_credentials",
      account_id: accountId,
    }),
  })

  if (!res.ok) {
    throw new RecordingDownloadError("zoom", res.status, `Zoom OAuth failed: ${res.status}`)
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number }

  if (!data.access_token) {
    throw new RecordingDownloadError("zoom", 502, "Zoom OAuth response had no access_token")
  }

  return { token: data.access_token, expiresInSeconds: data.expires_in }
})

/** Test hook: forget the cached OAuth token. */
export function resetZoomTokenCache() {
  zoomTokenCache.clear()
}

const MP4_VIEW_PREFERENCE = [
  "shared_screen_with_speaker_view",
  "speaker_view",
  "active_speaker",
  "shared_screen_with_gallery_view",
  "gallery_view",
  "shared_screen",
]

function fileType(file: ZoomRecordingFile) {
  return (file.file_type ?? file.file_extension ?? "").toUpperCase()
}

/**
 * Picks the best media file to transcribe: audio-only M4A first (smallest),
 * then MP4 views. Transcript/chat/timeline files and files that are still
 * processing are skipped.
 */
export function selectZoomRecordingFile(
  files: ZoomRecordingFile[] = []
): ZoomRecordingFile | undefined {
  const eligible = files.filter(
    (file) =>
      Boolean(file.download_url) &&
      (file.status === undefined || file.status === "completed") &&
      (fileType(file) === "M4A" || fileType(file) === "MP4")
  )
  const audio = eligible.find(
    (file) => file.recording_type === "audio_only" || fileType(file) === "M4A"
  )

  if (audio) return audio

  const videos = eligible.filter((file) => fileType(file) === "MP4")

  for (const view of MP4_VIEW_PREFERENCE) {
    const match = videos.find((file) => file.recording_type === view)
    if (match) return match
  }

  return videos[0]
}

function assertZoomDownloadUrl(value: string) {
  let url: URL

  try {
    url = new URL(value)
  } catch {
    throw new CaptureConfigError("Zoom recording URL is invalid")
  }

  const host = url.hostname.toLowerCase()
  const trusted = ["zoom.us", "zoomgov.com"].some(
    (domain) => host === domain || host.endsWith(`.${domain}`)
  )

  if (url.protocol !== "https:" || !trusted || url.username || url.password) {
    throw new CaptureConfigError("Refusing to download a Zoom recording from an untrusted URL")
  }

  // Never carry credentials in the URL; the token goes in the header.
  url.searchParams.delete("access_token")

  return url
}

export const zoomCaptureAdapter: CaptureAdapter = {
  platform: "zoom",

  validateWebhook(
    headers: Record<string, string>,
    body: string
  ): WebhookValidation {
    const secret = getZoomWebhookSecret()

    if (!secret) {
      return { valid: false, reason: "ZOOM_WEBHOOK_SECRET not configured" }
    }

    if (!verifyZoomSignature(headers, body, secret)) {
      return { valid: false, reason: "Invalid Zoom webhook signature" }
    }

    return { valid: true }
  },

  parseEvent(body: unknown): CaptureEvent | null {
    if (!isRecordingEvent(body)) return null

    const { object } = body.payload
    const file = selectZoomRecordingFile(object.recording_files)

    if (!file?.download_url) return null

    const isAudio = fileType(file) === "M4A" || file.recording_type === "audio_only"

    return {
      platform: "zoom",
      eventType: "recording.available",
      externalId: object.uuid,
      title: object.topic,
      startedAt: object.start_time,
      participants: [],
      recordingUrl: file.download_url,
      recordingMimeType: isAudio ? "audio/mp4" : "video/mp4",
      metadata: {
        zoomMeetingId: object.id,
        duration: object.duration,
        participantCount: object.participant_count,
        recordingFiles: object.recording_files?.length ?? 0,
        recordingFileId: file.id,
        recordingType: file.recording_type,
        fileType: fileType(file),
        fileSize: file.file_size,
      },
    }
  },

  parseEvents(body: unknown): CaptureEvent[] {
    const event = zoomCaptureAdapter.parseEvent(body)

    return event ? [event] : []
  },

  toMeetingInput(event: CaptureEvent): CreateMeetingInput {
    return {
      title: event.title,
      source: "zoom",
      language: "auto",
      startedAt: event.startedAt,
      participants: event.participants,
      externalSource: "zoom",
      externalId: event.externalId,
    }
  },

  async downloadRecording(event: CaptureEvent): Promise<RecordingDownload> {
    if (!event.recordingUrl) {
      throw new CaptureConfigError("No recording URL in Zoom event")
    }

    const url = assertZoomDownloadUrl(event.recordingUrl)
    const request = async () =>
      fetch(url, {
        headers: { Authorization: `Bearer ${await zoomTokenCache.get()}` },
        redirect: "follow",
      })
    let res = await request()

    if (res.status === 401) {
      // Token revoked/rotated early: refresh once.
      await res.body?.cancel().catch(() => {})
      zoomTokenCache.clear()
      res = await request()
    }

    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {})
      throw new RecordingDownloadError("zoom", res.ok ? 502 : res.status)
    }

    const isAudio = event.recordingMimeType?.startsWith("audio/")
    const declaredLength = Number(res.headers.get("content-length") ?? "")
    const metadataSize = Number(event.metadata.fileSize)

    return {
      body: res.body,
      filename: `zoom-${event.externalId.replace(/[^\w.-]+/g, "_")}.${isAudio ? "m4a" : "mp4"}`,
      contentType: event.recordingMimeType ?? "video/mp4",
      sizeBytes:
        Number.isFinite(declaredLength) && declaredLength > 0
          ? declaredLength
          : Number.isFinite(metadataSize) && metadataSize > 0
            ? metadataSize
            : undefined,
    }
  },
}
