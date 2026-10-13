"use client"

import { useEffect, useMemo, useState } from "react"
import { MicIcon, SquareIcon } from "lucide-react"

import { formatDockElapsed } from "@/components/bot/recorder-dock-state"
import { type BrowserRecorder, useBrowserRecorder } from "@/components/bot/use-browser-recorder"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { StatusPill } from "@/components/ui/meeting-atoms"
import { useOptionalI18n } from "@/components/i18n-provider"

type MeetingRecorderLabels = {
  ready: string
  record: string
  stop: string
  recording: string
  blocked: string
  unsupported: string
}

const defaultLabels: MeetingRecorderLabels = {
  ready: "Ready for in-person audio",
  record: "Record",
  stop: "Stop",
  recording: "Recording",
  blocked: "Microphone blocked",
  unsupported: "Recorder unsupported",
}

/**
 * Browser recorder control. The MediaRecorder logic lives in
 * `useBrowserRecorder` (M7); pass the shell's `recorder` so the recording
 * keeps running (and shows in the recorder dock) when this control unmounts.
 * Without it the control owns a recorder, as before.
 */
export function MeetingRecorder({
  labels = defaultLabels,
  onRecordingReady,
  recorder: sharedRecorder,
  meetingId,
}: {
  labels?: MeetingRecorderLabels
  onRecordingReady?: (file: File) => void
  recorder?: BrowserRecorder
  meetingId?: string | null
}) {
  const ownRecorder = useBrowserRecorder({
    onRecordingReady: sharedRecorder ? undefined : (file) => onRecordingReady?.(file),
  })
  const recorder = sharedRecorder ?? ownRecorder
  const i18n = useOptionalI18n()
  const storageFullLabel = i18n?.t("pwaStorageFull") ?? labels.unsupported
  const { state, startedAt } = recorder
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (state !== "recording") return

    const intervalId = window.setInterval(() => setNow(Date.now()), 1000)

    return () => window.clearInterval(intervalId)
  }, [state])

  const label = useMemo(() => {
    if (state === "recording") {
      return `${labels.recording} ${formatDockElapsed(startedAt ? now - startedAt : 0)}`
    }
    if (state === "blocked") return labels.blocked
    if (state === "unsupported") return labels.unsupported
    if (state === "storage-full") return storageFullLabel

    return labels.ready
  }, [labels, now, startedAt, state, storageFullLabel])

  return (
    <div className="flex items-center gap-3 rounded-md border border-line bg-surface p-3">
      {state === "recording" ? (
        <StatusPill status="live">
          <span className="[unicode-bidi:isolate]">{label}</span>
        </StatusPill>
      ) : (
        <Badge variant="secondary">{label}</Badge>
      )}
      {state === "recording" ? (
        <Button
          size="sm"
          variant="record"
          className="border-live bg-live-soft text-live-text"
          onClick={recorder.stop}
        >
          <SquareIcon data-icon="inline-start" />
          {labels.stop}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="record"
          onClick={(event) => {
            // Capture starts only from the user's own click or key press
            // (never from URL state or a scripted click; M9 security review).
            if (!event.nativeEvent.isTrusted) return
            void recorder.start({ meetingId: meetingId ?? null })
          }}
        >
          <MicIcon data-icon="inline-start" />
          {labels.record}
        </Button>
      )}
    </div>
  )
}
