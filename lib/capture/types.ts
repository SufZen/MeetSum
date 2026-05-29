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
 * Result of downloading a recording.
 */
export type RecordingDownload = {
  buffer: Buffer
  filename: string
  contentType: string
  sizeBytes: number
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
   * Convert a CaptureEvent into a CreateMeetingInput for the repository.
   */
  toMeetingInput: (event: CaptureEvent) => CreateMeetingInput

  /**
   * Download the recording file from the platform.
   * Returns the raw audio/video buffer with metadata.
   */
  downloadRecording: (event: CaptureEvent) => Promise<RecordingDownload>
}
