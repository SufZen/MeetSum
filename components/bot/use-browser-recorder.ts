"use client"

/**
 * In-browser MediaRecorder logic (M7 C3), extracted from
 * components/meeting-recorder.tsx so the shell can own one recorder and the
 * recorder dock survives navigation. Stop hands the file to the existing
 * `onRecordingReady` upload flow.
 *
 * M9 D5: with a `userId` and `workspaceId`, every 10 s chunk is also written
 * to the offline queue (IndexedDB, partitioned by user and workspace), so a closed tab or a lost connection
 * loses at most one chunk; stop assembles the chunks into a queued upload
 * identified by `captureId`. The queue code loads on the first recording.
 */
import { useCallback, useEffect, useRef, useState } from "react"

import type { UploadQueue } from "@/lib/client/upload-queue/queue"

export type BrowserRecorderState = "idle" | "recording" | "blocked" | "unsupported" | "storage-full"

export const RECORDER_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/mp4"] as const

/** MediaRecorder timeslice: the most a crash can lose. */
export const RECORDER_TIMESLICE_MS = 10_000

/** First supported container, or "" to let the browser choose. */
export function pickRecorderMimeType(isTypeSupported: (mime: string) => boolean): string {
  return RECORDER_MIME_CANDIDATES.find((mime) => isTypeSupported(mime)) ?? ""
}

export function isBrowserRecordingSupported(env: {
  hasMediaRecorder: boolean
  hasGetUserMedia: boolean
  isSecureContext: boolean
}): boolean {
  return env.hasMediaRecorder && env.hasGetUserMedia && env.isSecureContext
}

export function recordingFileName(now: number, mimeType: string): string {
  const extension = mimeType.startsWith("audio/mp4") ? "m4a" : "webm"

  return `meetsum-recording-${now}.${extension}`
}

export type RecordingMeta = {
  meetingId: string | null
  /** The offline-queue id of this recording (null without a user id). */
  captureId: string | null
}

export type BrowserRecorder = {
  state: BrowserRecorderState
  /** epoch ms the current recording started, or null. */
  startedAt: number | null
  /** The meeting the recording is for (dock "Open meeting"), when known. */
  meetingId: string | null
  start: (options?: { meetingId?: string | null }) => Promise<void>
  stop: () => void
}

/** Capture ids being recorded in this tab (never "recovered" by the queue). */
export const activeCaptureIds = new Set<string>()

function newCaptureId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `cap-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function useBrowserRecorder({
  onRecordingReady,
  userId,
  workspaceId,
  recordingTitle,
}: {
  onRecordingReady?: (file: File, meta: RecordingMeta) => void
  /** With `workspaceId`, enables the offline queue (partitioned by both). */
  userId?: string | null
  workspaceId?: string | null
  /** Title a queued recording gets when it uploads as its own meeting. */
  recordingTitle?: string
}): BrowserRecorder {
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const readyRef = useRef(onRecordingReady)
  const titleRef = useRef(recordingTitle)
  const [state, setState] = useState<BrowserRecorderState>("idle")
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [meetingId, setMeetingId] = useState<string | null>(null)

  useEffect(() => {
    readyRef.current = onRecordingReady
    titleRef.current = recordingTitle
  }, [onRecordingReady, recordingTitle])

  // Release the microphone if the owner unmounts mid-recording.
  useEffect(
    () => () => {
      const recorder = recorderRef.current

      if (recorder && recorder.state !== "inactive") recorder.stop()
    },
    []
  )

  const start = useCallback(
    async (options?: { meetingId?: string | null }) => {
      if (recorderRef.current && recorderRef.current.state !== "inactive") return
      if (
        !isBrowserRecordingSupported({
          hasMediaRecorder: typeof window !== "undefined" && "MediaRecorder" in window,
          hasGetUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
          isSecureContext: window.isSecureContext,
        })
      ) {
        setState("unsupported")
        return
      }

      let queue: UploadQueue | null = null

      if (userId && workspaceId) {
        try {
          const browser = await import("@/lib/client/upload-queue/browser")
          const candidate = browser.getUploadQueue(userId, workspaceId)
          const [free, snapshot] = await Promise.all([browser.freeStorageBytes(), candidate.snapshot()])
          const queued = snapshot.items.reduce((sum, item) => sum + item.size, 0)

          if (browser.storageGate(free, queued) === "refuse") {
            setState("storage-full")
            return
          }
          void browser.requestPersistentStorage()
          queue = candidate
        } catch {
          queue = null
        }
      }

      const activeQueue = queue

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const mimeType = pickRecorderMimeType((mime) => MediaRecorder.isTypeSupported(mime))
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
        const forMeeting = options?.meetingId ?? null
        const captureId = activeQueue ? newCaptureId() : null
        const startedIso = new Date().toISOString()
        const type = () => recorder.mimeType || mimeType || "audio/webm"
        let seq = 0
        let writes: Promise<unknown> = Promise.resolve()

        recorderRef.current = recorder
        chunksRef.current = []
        if (captureId) activeCaptureIds.add(captureId)
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data.size <= 0) return
          chunksRef.current.push(event.data)
          if (activeQueue && captureId) {
            const chunk = {
              captureId,
              seq: seq++,
              blob: event.data,
              startedAt: startedIso,
              mime: type(),
              meetingId: forMeeting,
            }

            writes = writes.then(() => activeQueue.recordChunk(chunk)).catch(() => undefined)
          }
        })
        recorder.addEventListener("stop", () => {
          stream.getTracks().forEach((track) => track.stop())

          const mime = type()
          const blob = new Blob(chunksRef.current, { type: mime })

          chunksRef.current = []
          recorderRef.current = null
          setState("idle")
          setStartedAt(null)
          setMeetingId(null)

          const handOff = () => {
            if (captureId) activeCaptureIds.delete(captureId)
            if (blob.size > 0) {
              readyRef.current?.(new File([blob], recordingFileName(Date.now(), mime), { type: mime }), {
                meetingId: forMeeting,
                captureId,
              })
            }
          }

          if (activeQueue && captureId) {
            const title = titleRef.current ?? recordingFileName(Date.now(), mime)

            void writes
              .then(() => activeQueue.finalize({ captureId, title, startedAt: startedIso, mime, meetingId: forMeeting }))
              .catch(() => undefined)
              .finally(handOff)
          } else {
            handOff()
          }
        })
        recorder.start(RECORDER_TIMESLICE_MS)
        setMeetingId(forMeeting)
        setStartedAt(Date.now())
        setState("recording")
      } catch {
        setState("blocked")
      }
    },
    [userId, workspaceId]
  )

  const stop = useCallback(() => {
    const recorder = recorderRef.current

    if (recorder && recorder.state !== "inactive") recorder.stop()
  }, [])

  return { state, startedAt, meetingId, start, stop }
}
