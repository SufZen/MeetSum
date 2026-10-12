import type { Readable } from "node:stream"
import type { ReadableStream as WebReadableStream } from "node:stream/web"

import type { CreateMeetingInput } from "@/lib/meetings/repository"

/**
 * Event types that a capture adapter can emit.
 */
export type CaptureEventType =
  | "recording.available"
  | "meeting.ended"
  | "transcript.ready"

/**
 * Normalized capture event from any platform.
 */
export type CaptureEvent = {
  platform: string
  eventType: CaptureEventType
  externalId: string
  title: string
  startedAt: string
  participants: string[]
  recordingUrl?: string
  recordingMimeType?: string
  metadata: Record<string, unknown>
}

/**
 * Result of webhook signature validation.
 */
export type WebhookValidation =
  | { valid: true }
  | { valid: false; reason: string }

/**
 * A streamed recording download. The body is consumed exactly once (piped
 * into object storage) and never buffered whole in memory.
 */
export type RecordingDownload = {
  body: Readable | WebReadableStream<Uint8Array> | ReadableStream<Uint8Array>
  filename: string
  contentType: string
  sizeBytes?: number
}

/** Missing/invalid platform credentials or configuration (not retryable). */
export class CaptureConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CaptureConfigError"
  }
}

/** HTTP failure while talking to a capture platform (status drives retries). */
export class RecordingDownloadError extends Error {
  readonly status: number
  readonly platform: string

  constructor(platform: string, status: number, message?: string) {
    super(message ?? `${platform} recording download failed: ${status}`)
    this.name = "RecordingDownloadError"
    this.status = status
    this.platform = platform
  }
}

/**
 * Interface that all platform capture adapters must implement.
 *
 * Pattern: similar to TranscriptionProvider / SummaryProvider in lib/ai/providers.ts.
 * Each adapter normalizes platform-specific webhook events into MeetSum's
 * CreateMeetingInput format and handles recording downloads.
 */
export type CaptureAdapter = {
  /** Unique identifier for this adapter (e.g., "zoom", "teams"). */
  readonly platform: string

  /**
   * Validate the webhook request signature.
   * Called before any event parsing to prevent unauthorized requests.
   */
  validateWebhook: (
    headers: Record<string, string>,
    body: string
  ) => WebhookValidation

  /**
   * Parse a raw webhook payload into a normalized CaptureEvent.
   * Returns null if the event type is not relevant (e.g., not a recording event).
   */
  parseEvent: (body: unknown) => CaptureEvent | null

  /**
   * Parse every relevant event in a (possibly batched) webhook payload.
   * Defaults to `[parseEvent(body)]` when an adapter doesn't batch.
   */
  parseEvents?: (body: unknown) => CaptureEvent[]

  /**
   * Convert a CaptureEvent into a CreateMeetingInput for the repository.
   */
  toMeetingInput: (event: CaptureEvent) => CreateMeetingInput

  /**
   * Download the recording file from the platform as a stream.
   */
  downloadRecording: (event: CaptureEvent) => Promise<RecordingDownload>
}
