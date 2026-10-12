import type { CaptureEvent } from "@/lib/capture/types"

export type PlatformRecordingImport = {
  assetId: string
  storageKey: string
  contentType: string
  sizeBytes: number
  reused: boolean
}

/** Downloads a Zoom/Teams cloud recording into object storage. Implemented in M1-B. */
export async function importPlatformRecording(input: {
  meetingId: string
  platform: "zoom" | "teams"
  captureEvent: CaptureEvent
}): Promise<PlatformRecordingImport> {
  void input
  throw new Error("not implemented (M1-B)")
}