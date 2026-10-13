import type { BotPlatform } from "@/lib/bot/types"

/**
 * Vexa v0.12.28 client contract (docs/parity/m7.md "Vexa facts", A1).
 * Everything outside lib/bot/vexa/** talks to BotProvider, so a fallback
 * provider (ScreenApp meeting-bot) only replaces this directory.
 */

export type VexaErrorKind =
  | "config"
  | "auth"
  | "conflict"
  | "capacity"
  | "invalid"
  | "not_found"
  | "unavailable"
  | "timeout"
  | "network"
  | "bad_response"

const RETRYABLE_KINDS: readonly VexaErrorKind[] = [
  "capacity",
  "unavailable",
  "timeout",
  "network",
]

/** Messages are redacted: no API key, passcode, pwd=/p= or Authorization. */
export class VexaError extends Error {
  readonly kind: VexaErrorKind
  readonly status?: number
  readonly code?: string
  readonly retryable: boolean

  constructor(
    kind: VexaErrorKind,
    message?: string,
    options: { status?: number; code?: string; retryable?: boolean } = {}
  ) {
    super(message ?? `Vexa error: ${kind}`)
    this.name = "VexaError"
    this.kind = kind
    this.status = options.status
    this.code = options.code
    this.retryable = options.retryable ?? RETRYABLE_KINDS.includes(kind)
  }
}

export type VexaClientOptions = {
  baseUrl: string
  apiKey: string
  fetch?: typeof fetch
  /** Default VEXA_TIMEOUT_MS. */
  timeoutMs?: number
  /** Default VEXA_STREAM_TIMEOUT_MS. */
  streamTimeoutMs?: number
  /** GET/DELETE retries (POST /bots is never auto-retried). Default 2. */
  retries?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Planned: idle, scheduled. Live: requested..stopping. Terminal: completed, failed. */
export type VexaMeetingStatus =
  | "idle"
  | "scheduled"
  | "requested"
  | "joining"
  | "awaiting_admission"
  | "needs_help"
  | "active"
  | "stopping"
  | "completed"
  | "failed"

/** POST /bots input; the client builds the snake_case body. */
export type VexaBotRequest = {
  platform: BotPlatform
  nativeMeetingId: string
  botName: string
  language?: string
  task?: "transcribe" | "translate"
  transcribeEnabled: boolean
  recordingEnabled: boolean
  passcode?: string
  meetingUrl?: string
  teamsBaseHost?: string
  authenticated?: boolean
  automaticLeave?: { maxTimeLeftAloneMs: number }
}

/** The POST /bots response body is undocumented; parsed tolerantly. */
export type VexaBotResult = {
  /** From `id | meeting_id | meeting.id`. */
  vexaMeetingId?: string
  status?: string
  raw: unknown
}

export type VexaServiceProvenance = {
  botAdmittedAt?: string
  botDepartedAt?: string
  /** served | never_admitted | ... */
  botOutcome?: string
  transcriptionProvider?: string
  lifecycleContractVersion?: string
}

export type VexaRecordingMedia = {
  id: string
  type?: string
  format?: string
  contentType?: string
  sizeBytes?: number
  durationSeconds?: number
}

export type VexaRecording = {
  id: string
  status?: string
  startedAt?: string
  media: VexaRecordingMedia[]
}

export type VexaMeeting = {
  id: string
  platform: BotPlatform
  nativeMeetingId: string
  status: VexaMeetingStatus | string
  startTime?: string
  endTime?: string
  constructedMeetingUrl?: string
  recordings: VexaRecording[]
  /** Failure/completion reason when Vexa reports one (e.g. evicted, left_alone). */
  reason?: string
  serviceProvenance?: VexaServiceProvenance
  raw: unknown
}

export type VexaRecordingMaster = {
  /** Followed only when its origin equals the base URL origin. */
  rawUrl?: string
  mediaId?: string
  raw: unknown
}

export type VexaMediaStream = {
  body: ReadableStream<Uint8Array>
  contentType?: string
  contentLength?: number
}

export type VexaTranscriptWord = {
  word: string
  start: number
  end: number
  probability?: number
}

export type VexaTranscriptSegment = {
  segmentId: string
  speaker?: string
  text: string
  /** Seconds, relative to the recording. */
  start: number
  end: number
  absoluteStartTime?: string
  language?: string
  completed?: boolean
  confidence?: number
  words?: VexaTranscriptWord[]
}

export type VexaTranscript = {
  vexaMeetingId: string
  segments: VexaTranscriptSegment[]
  raw: unknown
}

export type VexaActiveBot = {
  platform: BotPlatform
  nativeMeetingId: string
  vexaMeetingId?: string
  status?: string
}

export const VEXA_WEBHOOK_EVENTS = [
  "meeting.status_change",
  "meeting.started",
  "meeting.completed",
  "bot.failed",
] as const
export type VexaWebhookEvent = (typeof VEXA_WEBHOOK_EVENTS)[number]

export type VexaWebhookConfig = {
  url: string
  secret: string
  events: Partial<Record<VexaWebhookEvent, boolean>>
}

export type VexaWebhookInfo = {
  url?: string
  events?: Partial<Record<VexaWebhookEvent, boolean>>
  /** Never the secret itself (0.12.27+ does not return it). */
  secretConfigured?: boolean
  raw: unknown
}

export type VexaHealth = { ok: boolean; version?: string; raw?: unknown }

export type BotChatResult = "sent" | "unsupported"

/** The provider interface every non-vexa module depends on (A1). */
export interface BotProvider {
  requestBot(request: VexaBotRequest): Promise<VexaBotResult>
  stopBot(platform: BotPlatform, nativeMeetingId: string): Promise<{ status?: string; raw: unknown }>
  getMeeting(vexaMeetingId: string): Promise<VexaMeeting>
  findActiveBot(platform: BotPlatform, nativeMeetingId: string): Promise<VexaActiveBot | undefined>
  getRecordingMaster(recordingId: string, type: "audio"): Promise<VexaRecordingMaster>
  streamRecordingMedia(
    recordingId: string,
    mediaId: string,
    options?: { signal?: AbortSignal }
  ): Promise<VexaMediaStream>
  getTranscript(vexaMeetingId: string): Promise<VexaTranscript>
  sendChat(platform: BotPlatform, nativeMeetingId: string, text: string): Promise<BotChatResult>
  deleteMeeting(vexaMeetingId: string): Promise<void>
  configureWebhook(config: VexaWebhookConfig): Promise<void>
  getWebhook(): Promise<VexaWebhookInfo>
  health(): Promise<VexaHealth>
}
