import { randomUUID } from "node:crypto"

export type RecorderConfig = {
  meetSumUrl: string
  apiKey: string
  defaultLanguage?: string
}

export type DesktopTranscriptSegment = {
  text: string
  speaker?: string
  startMs: number
  endMs: number
  confidence?: number
  language?: string
}

export type DesktopRecorderMetadata = {
  captureId: string
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
  uploadStatus: "uploaded" | "spooled" | "retry"
}

export type DesktopCaptureManifest = {
  id: string
  status: "spooled" | "uploading" | "uploaded" | "failed"
  meeting: {
    title: string
    startedAt: string
    endedAt?: string
    participants?: string[]
    language?: string
    source: "desktop_recorder"
  }
  media: {
    path: string
    filename: string
    contentType: string
    sizeBytes: number
  }
  captureMetadata: DesktopRecorderMetadata
  transcriptSegments?: DesktopTranscriptSegment[]
  uploadedMeetingId?: string
  lastError?: string
  createdAt: string
  updatedAt: string
}

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function assertIsoDate(value: string, field: string) {
  const parsed = new Date(value)

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} must be an ISO date`)
  }

  return parsed.toISOString()
}

function platformFromNode(value = process.platform) {
  if (value === "win32") return "windows"
  if (value === "darwin") return "macos"
  if (value === "linux") return "linux"
  return "unknown"
}

export function normalizeRecorderConfig(input: {
  meetSumUrl?: string
  apiKey?: string
  defaultLanguage?: string
}): RecorderConfig {
  const meetSumUrl = cleanString(input.meetSumUrl)?.replace(/\/+$/, "")
  const apiKey = cleanString(input.apiKey)

  if (!meetSumUrl) throw new Error("MeetSum URL is required")
  if (!apiKey) throw new Error("MeetSum API key is required")

  return {
    meetSumUrl,
    apiKey,
    defaultLanguage: cleanString(input.defaultLanguage),
  }
}

export function buildDesktopCaptureMetadata(input: {
  captureId?: string
  appVersion?: string
  platform?: "windows" | "macos" | "linux" | "unknown"
  microphoneName?: string
  systemAudioName?: string
  sampleRate?: number
  durationMs?: number
  endedAt?: string
  localTranscription?: {
    provider?: string
    model?: string
  }
  uploadStatus?: "uploaded" | "spooled" | "retry"
}): DesktopRecorderMetadata {
  const deviceNames = {
    microphone: cleanString(input.microphoneName),
    systemAudio: cleanString(input.systemAudioName),
  }
  const localTranscription = input.localTranscription
    ? {
        provider: cleanString(input.localTranscription.provider),
        model: cleanString(input.localTranscription.model),
      }
    : undefined
  const metadata: DesktopRecorderMetadata = {
    captureId: cleanString(input.captureId) ?? `cap_${randomUUID()}`,
    appVersion: cleanString(input.appVersion),
    platform: input.platform ?? platformFromNode(),
    sampleRate:
      typeof input.sampleRate === "number" && input.sampleRate > 0
        ? input.sampleRate
        : undefined,
    durationMs:
      typeof input.durationMs === "number" && input.durationMs > 0
        ? Math.trunc(input.durationMs)
        : undefined,
    endedAt: input.endedAt ? assertIsoDate(input.endedAt, "endedAt") : undefined,
    localTranscription,
    uploadStatus: input.uploadStatus ?? "spooled",
  }

  if (deviceNames.microphone || deviceNames.systemAudio) {
    metadata.deviceNames = deviceNames
  }
  if (!localTranscription?.provider && !localTranscription?.model) {
    delete metadata.localTranscription
  }

  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined)
  ) as DesktopRecorderMetadata
}

export function createCaptureManifest(input: {
  title: string
  startedAt: string
  endedAt?: string
  participants?: string[]
  language?: string
  mediaPath: string
  contentType: string
  sizeBytes: number
  metadata: DesktopRecorderMetadata
  transcriptSegments?: DesktopTranscriptSegment[]
}): DesktopCaptureManifest {
  const now = new Date().toISOString()
  const title = cleanString(input.title) ?? "Desktop recording"
  const mediaPath = cleanString(input.mediaPath)

  if (!mediaPath) throw new Error("Media path is required")

  return {
    id: input.metadata.captureId,
    status: input.metadata.uploadStatus === "uploaded" ? "uploaded" : "spooled",
    meeting: {
      title,
      startedAt: assertIsoDate(input.startedAt, "startedAt"),
      endedAt: input.endedAt ? assertIsoDate(input.endedAt, "endedAt") : undefined,
      participants: input.participants?.filter(Boolean),
      language: cleanString(input.language),
      source: "desktop_recorder",
    },
    media: {
      path: mediaPath,
      filename: mediaPath.split(/[\\/]/).pop() ?? "recording.webm",
      contentType: cleanString(input.contentType) ?? "audio/webm",
      sizeBytes: Math.max(0, Math.trunc(input.sizeBytes)),
    },
    captureMetadata: input.metadata,
    transcriptSegments: input.transcriptSegments,
    createdAt: now,
    updatedAt: now,
  }
}
