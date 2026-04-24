"use client"

import { useState } from "react"
import {
  BookmarkIcon,
  ExpandIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  RotateCwIcon,
  Volume2Icon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import type { MeetingRecord } from "@/lib/meetings/repository"

function meetingDuration(meeting: MeetingRecord) {
  const last = meeting.transcript?.at(-1)

  return last ? Math.max(3738, Math.round(last.endMs / 1000)) : 3738
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60

  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`
}

export function AudioPlaybackBar({ meeting }: { meeting: MeetingRecord }) {
  const [playing, setPlaying] = useState(false)
  const duration = meetingDuration(meeting)

  return (
    <div className="mt-8 flex min-h-14 flex-wrap items-center gap-3 rounded-md border bg-white px-3 py-2 shadow-sm">
      <Button
        size="icon"
        className="size-9 rounded-full bg-teal-700 text-white hover:bg-teal-800"
        onClick={() => setPlaying((current) => !current)}
      >
        {playing ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
        <span className="sr-only">{playing ? "Pause" : "Play"}</span>
      </Button>
      <Button variant="ghost" size="icon-sm">
        <RotateCcwIcon className="size-4" />
      </Button>
      <Button variant="ghost" size="icon-sm">
        <RotateCwIcon className="size-4" />
      </Button>
      <Button variant="ghost" size="sm" className="h-8">
        1x
      </Button>
      <span className="font-mono text-xs text-slate-600">
        00:00 / {formatDuration(duration)}
      </span>
      <BookmarkIcon aria-hidden="true" className="ms-auto size-4 text-slate-500" />
      <Volume2Icon aria-hidden="true" className="size-4 text-slate-500" />
      <div className="flex h-6 min-w-[180px] flex-1 items-center gap-px">
        {Array.from({ length: 48 }).map((_, index) => (
          <span
            key={index}
            className={
              index % 11 === 0
                ? "h-5 w-0.5 rounded-full bg-amber-400"
                : index < 16
                  ? "h-4 w-0.5 rounded-full bg-cyan-400"
                  : "h-3 w-0.5 rounded-full bg-slate-300"
            }
          />
        ))}
      </div>
      <ExpandIcon aria-hidden="true" className="size-4 text-slate-500" />
    </div>
  )
}
