"use client"

import { useMemo, useRef, useState } from "react"
import { MicIcon, SquareIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

type RecorderState = "idle" | "recording" | "blocked" | "unsupported"

export function MeetingRecorder() {
  const mediaRecorder = useRef<MediaRecorder | null>(null)
  const [state, setState] = useState<RecorderState>("idle")
  const [seconds, setSeconds] = useState(0)

  const label = useMemo(() => {
    if (state === "recording") {
      return `Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
    }

    if (state === "blocked") {
      return "Microphone blocked"
    }

    if (state === "unsupported") {
      return "Recorder unsupported"
    }

    return "Ready for in-person audio"
  }, [seconds, state])

  async function startRecording() {
    if (!("MediaRecorder" in window)) {
      setState("unsupported")
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaRecorder.current = new MediaRecorder(stream)
      mediaRecorder.current.start()
      setState("recording")
      setSeconds(0)

      const intervalId = window.setInterval(() => {
        setSeconds((current) => current + 1)
      }, 1000)

      mediaRecorder.current.addEventListener("stop", () => {
        window.clearInterval(intervalId)
        stream.getTracks().forEach((track) => track.stop())
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
          Stop
        </Button>
      ) : (
        <Button size="sm" onClick={startRecording}>
          <MicIcon data-icon="inline-start" />
          Record
        </Button>
      )}
    </div>
  )
}
