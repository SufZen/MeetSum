"use client"

/**
 * In-browser MediaRecorder logic (M7 C3), extracted from
 * components/meeting-recorder.tsx so the shell can own one recorder and the
 * recorder dock survives navigation. Stop hands the file to the existing
 * `onRecordingReady` upload flow.
 */
import { useCallback, useEffect, useRef, useState } from "react"

export type BrowserRecorderState = "idle" | "recording" | "blocked" | "unsupported"

export const RECORDER_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/mp4"] as const

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

export type BrowserRecorder = {
  state: BrowserRecorderState
  /** epoch ms the current recording started, or null. */
  startedAt: number | null
  /** The meeting the recording is for (dock "Open meeting"), when known. */
  meetingId: string | null
  start: (options?: { meetingId?: string | null }) => Promise<void>
  stop: () => void
}

export function useBrowserRecorder({
  onRecordingReady,
}: {
  onRecordingReady?: (file: File, meta: { meetingId: string | null }) => void
}): BrowserRecorder {
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const readyRef = useRef(onRecordingReady)
  const [state, setState] = useState<BrowserRecorderState>("idle")
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [meetingId, setMeetingId] = useState<string | null>(null)

  useEffect(() => {
    readyRef.current = onRecordingReady
  }, [onRecordingReady])

  // Release the microphone if the owner unmounts mid-recording.
  useEffect(
    () => () => {
      const recorder = recorderRef.current

      if (recorder && recorder.state !== "inactive") recorder.stop()
    },
    []
  )

  const start = useCallback(async (options?: { meetingId?: string | null }) => {
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

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = pickRecorderMimeType((mime) => MediaRecorder.isTypeSupported(mime))
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      const forMeeting = options?.meetingId ?? null

      recorderRef.current = recorder
      chunksRef.current = []
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      })
      recorder.addEventListener("stop", () => {
        stream.getTracks().forEach((track) => track.stop())

        const type = recorder.mimeType || "audio/webm"
        const blob = new Blob(chunksRef.current, { type })

        chunksRef.current = []
        recorderRef.current = null
        setState("idle")
        setStartedAt(null)
        setMeetingId(null)
        if (blob.size > 0) {
          readyRef.current?.(new File([blob], recordingFileName(Date.now(), type), { type }), {
            meetingId: forMeeting,
          })
        }
      })
      recorder.start(1000)
      setMeetingId(forMeeting)
      setStartedAt(Date.now())
      setState("recording")
    } catch {
      setState("blocked")
    }
  }, [])

  const stop = useCallback(() => {
    const recorder = recorderRef.current

    if (recorder && recorder.state !== "inactive") recorder.stop()
  }, [])

  return { state, startedAt, meetingId, start, stop }
}
