"use client"

import { useMemo, useRef, useState } from "react"
import { MicIcon, SquareIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

type RecorderState = "idle" | "recording" | "blocked" | "unsupported"

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

export function MeetingRecorder({
  labels = defaultLabels,
  onRecordingReady,
}: {
  labels?: MeetingRecorderLabels
  onRecordingReady?: (file: File) => void
}) {
  const mediaRecorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<BlobPart[]>([])
  const [state, setState] = useState<RecorderState>("idle")
  const [seconds, setSeconds] = useState(0)

  const label = useMemo(() => {
    if (state === "recording") {
      return `${labels.recording} ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
    }

    if (state === "blocked") {
      return labels.blocked
    }

    if (state === "unsupported") {
      return labels.unsupported
    }

    return labels.ready
  }, [labels, seconds, state])

  async function startRecording() {
    if (!("MediaRecorder" in window)) {
      setState("unsupported")
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaRecorder.current = new MediaRecorder(stream)
      chunks.current = []
      mediaRecorder.current.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          chunks.current.push(event.data)
        }
      })
      mediaRecorder.current.start()
      setState("recording")
      setSeconds(0)

      const intervalId = window.setInterval(() => {
        setSeconds((current) => current + 1)
      }, 1000)

      mediaRecorder.current.addEventListener("stop", () => {
        window.clearInterval(intervalId)
        stream.getTracks().forEach((track) => track.stop())
        const blob = new Blob(chunks.current, {
          type: mediaRecorder.current?.mimeType || "audio/webm",
        })

        if (blob.size > 0) {
          onRecordingReady?.(
            new File([blob], `meetsum-recording-${Date.now()}.webm`, {
              type: blob.type,
            })
          )
        }
        setState("idle")
      })
    } catch {
      setState("blocked")
    }
  }

  function stopRecording() {
    mediaRecorder.current?.stop()
  }

  return (
    <div className="flex items-center gap-3 rounded-md border bg-background p-3">
      <Badge variant={state === "recording" ? "default" : "secondary"}>
        {label}
      </Badge>
      {state === "recording" ? (
        <Button size="sm" variant="outline" onClick={stopRecording}>
          <SquareIcon data-icon="inline-start" />
          {labels.stop}
        </Button>
      ) : (
        <Button size="sm" onClick={startRecording}>
          <MicIcon data-icon="inline-start" />
          {labels.record}
        </Button>
      )}
    </div>
  )
}
