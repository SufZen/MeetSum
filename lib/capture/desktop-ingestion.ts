import type {
  CreateMeetingInput,
  MeetingSource,
  TranscriptSegment,
} from "@/lib/meetings/repository"
import type { MeetSumJobName } from "@/lib/jobs/queue"
import { getDatabasePool } from "@/lib/db/client"

export type DesktopCaptureMetadata = {
  captureId?: string
  appVersion?: string
  platform?: "windows" | "macos" | "linux" | "unknown"
  deviceNames?: {
    microphone?: string
    systemAudio?: string
  }
  sampleRate?: number
  durationMs?: number
  endedAt?: string
  localTranscription?: {
    provider?: string
    model?: string
  }
  uploadStatus?: "uploaded" | "spooled" | "retry"
}

export type DesktopIngestionPlan = {
  jobName: MeetSumJobName
  mode: "desktop-media" | "desktop-transcript"
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function optionalPositiveNumber(value: unknown) {
  const numeric = Number(value)

  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined
}

function clampConfidence(value: unknown) {
  const numeric = Number(value)

  if (!Number.isFinite(numeric)) return undefined
  return Math.min(1, Math.max(0, numeric))
}

function assertIsoDate(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} is required`)
  }

  const parsed = new Date(value)

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} must be an ISO date`)
  }

  return parsed.toISOString()
}

export function parseDesktopMeetingInput(payload: unknown): {
  meeting: CreateMeetingInput
  endedAt?: string
} {
  const input = readObject(payload)
  const title = optionalString(input.title)

  if (!title) {
    throw new Error("title is required")
  }

  const participants = Array.isArray(input.participants)
    ? input.participants
        .map((participant) => optionalString(participant))
        .filter((participant): participant is string => Boolean(participant))
    : []
  const requestedSource = optionalString(input.source) as MeetingSource | undefined
  const source = requestedSource === "desktop_recorder"
    ? requestedSource
    : "desktop_recorder"

  return {
    meeting: {
      title,
      source,
      language: optionalString(input.language) ?? "he",
      startedAt: assertIsoDate(input.startedAt, "startedAt"),
      participants,
    },
    endedAt: input.endedAt ? assertIsoDate(input.endedAt, "endedAt") : undefined,
  }
}

export function normalizeDesktopTranscriptSegments(
  payload: unknown,
  fallbackLanguage = "he"
): TranscriptSegment[] {
  const items = Array.isArray(payload) ? payload : []

  return items
    .map((item, index): TranscriptSegment | undefined => {
      const segment = readObject(item)
      const text = optionalString(segment.text)

      if (!text) return undefined

      const startMs = Math.max(0, Math.trunc(Number(segment.startMs ?? 0)))
      const requestedEndMs = Math.trunc(Number(segment.endMs ?? startMs + 1000))
      const endMs = Math.max(startMs + 1000, requestedEndMs)
      const speaker = optionalString(segment.speaker) ?? `Speaker ${index + 1}`

      return {
        id: optionalString(segment.id) ?? `seg_${crypto.randomUUID()}`,
        speaker,
        startMs,
        endMs,
        text,
        confidence: clampConfidence(segment.confidence),
        language: optionalString(segment.language) ?? fallbackLanguage,
      }
    })
    .filter((segment): segment is TranscriptSegment => Boolean(segment))
}

export function normalizeDesktopCaptureMetadata(
  payload: unknown
): DesktopCaptureMetadata {
  const input = readObject(payload)
  const devices = readObject(input.deviceNames)
  const localTranscription = readObject(input.localTranscription)
  const platform = optionalString(input.platform)
  const uploadStatus = optionalString(input.uploadStatus)
  const metadata: DesktopCaptureMetadata = {}

  metadata.captureId = optionalString(input.captureId)
  metadata.appVersion = optionalString(input.appVersion)
  metadata.platform =
    platform === "windows" || platform === "macos" || platform === "linux"
      ? platform
      : platform
        ? "unknown"
        : undefined
  metadata.deviceNames = {
    microphone: optionalString(devices.microphone),
    systemAudio: optionalString(devices.systemAudio),
  }
  if (!metadata.deviceNames.microphone && !metadata.deviceNames.systemAudio) {
    delete metadata.deviceNames
  }
  metadata.sampleRate = optionalPositiveNumber(input.sampleRate)
  metadata.durationMs = optionalPositiveNumber(input.durationMs)
  metadata.endedAt = input.endedAt
    ? assertIsoDate(input.endedAt, "endedAt")
    : undefined
  metadata.localTranscription = {
    provider: optionalString(localTranscription.provider),
    model: optionalString(localTranscription.model),
  }
  if (
    !metadata.localTranscription.provider &&
    !metadata.localTranscription.model
  ) {
    delete metadata.localTranscription
  }
  metadata.uploadStatus =
    uploadStatus === "spooled" || uploadStatus === "retry"
      ? uploadStatus
      : uploadStatus
        ? "uploaded"
        : undefined

  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined)
  ) as DesktopCaptureMetadata
}

export function buildDesktopCaptureIngestionPlan(options: {
  hasFile: boolean
  transcriptSegments: number
}): DesktopIngestionPlan {
  if (options.transcriptSegments > 0) {
    return {
      jobName: "meeting.summarize",
      mode: "desktop-transcript",
    }
  }

  return {
    jobName: "media.ingest",
    mode: "desktop-media",
  }
}

export function parseDesktopJsonField(
  formData: FormData,
  field: string
): unknown {
  const value = formData.get(field)

  if (typeof value !== "string" || !value.trim()) return undefined

  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`${field} must be valid JSON`)
  }
}

export async function recordDesktopTranscriptionRun(options: {
  meetingId: string
  segmentCount: number
  metadata: DesktopCaptureMetadata
}) {
  if (process.env.MEETSUM_STORAGE !== "postgres") return

  const localTranscription = options.metadata.localTranscription
  const provider = localTranscription?.provider ?? "desktop-local"
  const model = localTranscription?.model ?? "desktop-companion"

  await getDatabasePool().query(
    `
      insert into ai_runs (
        id, meeting_id, provider, task, status, metadata, model,
        latency_ms, confidence, started_at, completed_at
      )
      values ($1, $2, $3, 'audio.transcribe', 'completed', $4::jsonb, $5,
              null, null, now(), now())
    `,
    [
      `airun_${crypto.randomUUID()}`,
      options.meetingId,
      provider,
      JSON.stringify({
        source: "desktop-capture",
        localTranscript: true,
        segments: options.segmentCount,
        captureMetadata: options.metadata,
      }),
      model,
    ]
  )
}
