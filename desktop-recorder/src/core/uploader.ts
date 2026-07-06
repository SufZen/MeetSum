import { readFile as defaultReadFile } from "node:fs/promises"

import type { DesktopCaptureManifest, RecorderConfig } from "./manifest.js"
import { normalizeRecorderConfig } from "./manifest.js"

export type DesktopUploadResult = {
  meetingId?: string
  status: number
}

type UploadDependencies = Partial<RecorderConfig> & {
  readFile?: (path: string) => Promise<Buffer>
  fetch?: typeof fetch
}

function responseMeetingId(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined
  const record = payload as Record<string, unknown>
  const meeting = record.meeting

  return meeting && typeof meeting === "object"
    ? (meeting as Record<string, unknown>).id as string | undefined
    : undefined
}

export async function uploadDesktopCapture(
  manifest: DesktopCaptureManifest,
  dependencies: UploadDependencies
): Promise<DesktopUploadResult> {
  const config = normalizeRecorderConfig(dependencies)
  const readFile = dependencies.readFile ?? defaultReadFile
  const fetchImpl = dependencies.fetch ?? fetch
  const bytes = await readFile(manifest.media.path)
  const formData = new FormData()

  formData.set("meeting", JSON.stringify(manifest.meeting))
  formData.set("captureMetadata", JSON.stringify(manifest.captureMetadata))
  if (manifest.transcriptSegments?.length) {
    formData.set("transcript", JSON.stringify(manifest.transcriptSegments))
  }
  formData.set(
    "file",
    new File([new Uint8Array(bytes)], manifest.media.filename, {
      type: manifest.media.contentType,
    })
  )

  const response = await fetchImpl(
    `${config.meetSumUrl}/api/desktop-capture/ingest`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}` },
      body: formData,
    }
  )
  const payload = await response.json().catch(() => undefined)

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `MeetSum upload failed with ${response.status}`

    throw new Error(message)
  }

  return {
    meetingId: responseMeetingId(payload),
    status: response.status,
  }
}
