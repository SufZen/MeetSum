import { app, BrowserWindow, desktopCapturer, ipcMain, shell } from "electron"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  buildDesktopCaptureMetadata,
  createCaptureManifest,
  normalizeRecorderConfig,
  type RecorderConfig,
} from "../core/manifest.js"
import {
  listPendingCaptures,
  markCaptureFailed,
  markCaptureUploaded,
  markCaptureUploading,
  writeCaptureManifest,
} from "../core/spool.js"
import { uploadDesktopCapture } from "../core/uploader.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const sourceRoot = resolve(__dirname, "../../src")
const rendererPath = join(sourceRoot, "renderer", "index.html")
const preloadPath = join(sourceRoot, "main", "preload.cjs")

type SaveCapturePayload = {
  title?: string
  startedAt: string
  endedAt: string
  language?: string
  microphoneName?: string
  systemAudioName?: string
  sampleRate?: number
  durationMs?: number
  media: {
    bytes: ArrayBuffer
    contentType: string
  }
}

function appVersion() {
  return app.getVersion() || "0.1.0"
}

function userDataPath(...parts: string[]) {
  return join(app.getPath("userData"), ...parts)
}

async function readConfig(): Promise<RecorderConfig | undefined> {
  const configPath = userDataPath("config.json")

  try {
    return normalizeRecorderConfig(
      JSON.parse(await readFile(configPath, "utf8")) as Record<string, string>
    )
  } catch {
    return undefined
  }
}

async function saveConfig(input: Partial<RecorderConfig>) {
  const config = normalizeRecorderConfig(input)
  const configPath = userDataPath("config.json")

  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, JSON.stringify(config, null, 2))
  return config
}

async function uploadPendingCapture(captureId: string) {
  const config = await readConfig()

  if (!config) {
    throw new Error("Configure MeetSum URL and API key before uploading")
  }

  const spoolDir = userDataPath("spool")
  const manifestPath = join(spoolDir, `${captureId}.json`)

  await markCaptureUploading(spoolDir, captureId)

  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    const result = await uploadDesktopCapture(manifest, config)

    await markCaptureUploaded(spoolDir, captureId, result.meetingId ?? "")
    return result
  } catch (error) {
    await markCaptureFailed(
      spoolDir,
      captureId,
      error instanceof Error ? error.message : "Upload failed"
    )
    throw error
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 820,
    minHeight: 620,
    title: "MeetSum Capture",
    webPreferences: {
      contextIsolation: true,
      preload: preloadPath,
    },
  })

  void win.loadFile(rendererPath)
  return win
}

app.whenReady().then(() => {
  ipcMain.handle("config:read", readConfig)
  ipcMain.handle("config:save", (_event, input: Partial<RecorderConfig>) =>
    saveConfig(input)
  )
  ipcMain.handle("sources:list", async () =>
    (await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 240, height: 135 },
      fetchWindowIcons: true,
    })).map((source) => ({ id: source.id, name: source.name }))
  )
  ipcMain.handle("spool:list", () => listPendingCaptures(userDataPath("spool")))
  ipcMain.handle("capture:save", async (_event, payload: SaveCapturePayload) => {
    const captureId = `cap_${crypto.randomUUID()}`
    const spoolDir = userDataPath("spool")
    const mediaDir = userDataPath("media")
    const filename = `${captureId}.webm`
    const mediaPath = join(mediaDir, filename)
    const bytes = Buffer.from(payload.media.bytes)

    await mkdir(mediaDir, { recursive: true })
    await writeFile(mediaPath, bytes)

    const manifest = createCaptureManifest({
      title: payload.title || "Desktop recording",
      startedAt: payload.startedAt,
      endedAt: payload.endedAt,
      language: payload.language,
      mediaPath,
      contentType: payload.media.contentType || "audio/webm",
      sizeBytes: bytes.length,
      metadata: buildDesktopCaptureMetadata({
        captureId,
        appVersion: appVersion(),
        microphoneName: payload.microphoneName,
        systemAudioName: payload.systemAudioName,
        sampleRate: payload.sampleRate,
        durationMs: payload.durationMs,
        endedAt: payload.endedAt,
        uploadStatus: "spooled",
      }),
    })

    await writeCaptureManifest(spoolDir, manifest)
    return manifest
  })
  ipcMain.handle("capture:upload", (_event, captureId: string) =>
    uploadPendingCapture(captureId)
  )
  ipcMain.handle("external:open-spool", () => shell.openPath(userDataPath()))

  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
