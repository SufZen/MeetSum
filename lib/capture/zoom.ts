import { createHmac, timingSafeEqual } from "node:crypto"

import type {
  CaptureAdapter,
  CaptureEvent,
  RecordingDownload,
  WebhookValidation,
} from "@/lib/capture/types"
import type { CreateMeetingInput } from "@/lib/meetings/repository"

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
      recording_files?: Array<{
        id: string
        meeting_id: string
        recording_start: string
        recording_end: string
        file_type: string
        file_extension: string
        file_size: number
        download_url: string
        recording_type: string
      }>
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

function isZoomChallenge(body: unknown): body is ZoomChallenge {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { event?: string }).event === "endpoint.url_validation"
  )
}

function isRecordingEvent(body: unknown): body is ZoomRecordingEvent {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { event?: string }).event === "recording.completed"
  )
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

  if (!timestamp || !signature) return false

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
 * Get a Zoom Server-to-Server OAuth access token.
 */
async function getZoomAccessToken(): Promise<string> {
  const accountId = process.env.ZOOM_ACCOUNT_ID ?? ""
  const clientId = process.env.ZOOM_CLIENT_ID ?? ""
  const clientSecret = process.env.ZOOM_CLIENT_SECRET ?? ""

  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  )

  if (!res.ok) {
    throw new Error(`Zoom OAuth failed: ${res.status}`)
  }

  const data = (await res.json()) as { access_token: string }
  return data.access_token
}

/**
 * Handle Zoom URL validation challenge.
 */
export function handleZoomChallenge(body: ZoomChallenge): {
  plainToken: string
  encryptedToken: string
} {
  const secret = process.env.ZOOM_WEBHOOK_SECRET ?? ""
  return {
    plainToken: body.payload.plainToken,
    encryptedToken: createHmac("sha256", secret)
      .update(body.payload.plainToken)
      .digest("hex"),
  }
}

export const zoomCaptureAdapter: CaptureAdapter = {
  platform: "zoom",

  validateWebhook(
    headers: Record<string, string>,
    body: string
  ): WebhookValidation {
    const secret = process.env.ZOOM_WEBHOOK_SECRET ?? ""

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
    const mp4 = object.recording_files?.find(
      (f) => f.file_type === "MP4" || f.file_extension === "MP4"
    )

    return {
      platform: "zoom",
      eventType: "recording.available",
      externalId: object.uuid,
      title: object.topic,
      startedAt: object.start_time,
      participants: [],
      recordingUrl: mp4?.download_url,
      recordingMimeType: "video/mp4",
      metadata: {
        zoomMeetingId: object.id,
        duration: object.duration,
        participantCount: object.participant_count,
        recordingFiles: object.recording_files?.length ?? 0,
      },
    }
  },

  toMeetingInput(event: CaptureEvent): CreateMeetingInput {
    return {
      title: event.title,
      source: "zoom",
      language: "auto",
      startedAt: event.startedAt,
      participants: event.participants,
    }
  },

  async downloadRecording(event: CaptureEvent): Promise<RecordingDownload> {
    if (!event.recordingUrl) {
      throw new Error("No recording URL in Zoom event")
    }

    const token = await getZoomAccessToken()
    const url = `${event.recordingUrl}?access_token=${token}`
    const res = await fetch(url)

    if (!res.ok) {
      throw new Error(`Zoom recording download failed: ${res.status}`)
    }

    const buffer = Buffer.from(await res.arrayBuffer())

    return {
      buffer,
      filename: `zoom-${event.externalId}.mp4`,
      contentType: event.recordingMimeType ?? "video/mp4",
      sizeBytes: buffer.byteLength,
    }
  },
}
