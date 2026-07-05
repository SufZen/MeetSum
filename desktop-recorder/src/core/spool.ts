import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { DesktopCaptureManifest } from "./manifest.js"

function manifestPath(spoolDir: string, captureId: string) {
  return join(spoolDir, `${captureId}.json`)
}

async function readManifest(path: string): Promise<DesktopCaptureManifest> {
  return JSON.parse(await readFile(path, "utf8")) as DesktopCaptureManifest
}

export async function writeCaptureManifest(
  spoolDir: string,
  manifest: DesktopCaptureManifest
) {
  await mkdir(spoolDir, { recursive: true })
  await writeFile(
    manifestPath(spoolDir, manifest.id),
    JSON.stringify({ ...manifest, updatedAt: new Date().toISOString() }, null, 2)
  )
}

export async function listPendingCaptures(spoolDir: string) {
  await mkdir(spoolDir, { recursive: true })
  const files = await readdir(spoolDir)
  const manifests = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map((file) => readManifest(join(spoolDir, file)))
  )

  return manifests
    .filter((manifest) =>
      manifest.status === "spooled" || manifest.status === "failed"
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function markCaptureUploading(spoolDir: string, captureId: string) {
  const manifest = await readManifest(manifestPath(spoolDir, captureId))
  await writeCaptureManifest(spoolDir, {
    ...manifest,
    status: "uploading",
    captureMetadata: { ...manifest.captureMetadata, uploadStatus: "retry" },
  })
}

export async function markCaptureUploaded(
  spoolDir: string,
  captureId: string,
  meetingId: string
) {
  const manifest = await readManifest(manifestPath(spoolDir, captureId))
  await writeCaptureManifest(spoolDir, {
    ...manifest,
    status: "uploaded",
    uploadedMeetingId: meetingId,
    lastError: undefined,
    captureMetadata: { ...manifest.captureMetadata, uploadStatus: "uploaded" },
  })
}

export async function markCaptureFailed(
  spoolDir: string,
  captureId: string,
  error: string
) {
  const manifest = await readManifest(manifestPath(spoolDir, captureId))
  await writeCaptureManifest(spoolDir, {
    ...manifest,
    status: "failed",
    lastError: error,
    captureMetadata: { ...manifest.captureMetadata, uploadStatus: "retry" },
  })
}
