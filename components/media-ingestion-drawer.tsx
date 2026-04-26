"use client"

import type { ChangeEvent } from "react"
import { MicIcon, UploadIcon } from "lucide-react"

import { MeetingRecorder } from "@/components/meeting-recorder"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import type { Dictionary } from "@/lib/i18n/dictionaries"

export function MediaIngestionDrawer({
  dictionary,
  pending,
  mode = "upload",
  open,
  onOpenChange,
  onFileChange,
  onRecordingReady,
}: {
  dictionary: Dictionary
  pending?: boolean
  mode?: "upload" | "record"
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void
  onRecordingReady: (file: File) => void
}) {
  const triggerLabel = mode === "record" ? dictionary.record : dictionary.upload
  const TriggerIcon = mode === "record" ? MicIcon : UploadIcon

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger render={<Button className="h-9" disabled={pending} />}>
        <TriggerIcon data-icon="inline-start" />
        {triggerLabel}
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Ingest meeting media</SheetTitle>
          <SheetDescription>
            Upload audio/video or record in-person audio directly into the
            processing pipeline.
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-4 p-4">
          <label className="grid min-h-36 cursor-pointer place-items-center rounded-md border border-dashed bg-muted/40 p-6 text-center text-sm text-muted-foreground">
            <UploadIcon aria-hidden="true" className="mb-2 size-6 text-primary" />
            <span className="font-medium text-foreground">
              Choose audio or video
            </span>
            <span>Gemini-ready files are stored privately in MinIO first.</span>
            <input
              type="file"
              className="hidden"
              accept="audio/*,video/*"
              onChange={onFileChange}
            />
          </label>
          <MeetingRecorder
            onRecordingReady={onRecordingReady}
            labels={{
              ready: dictionary.recorderReady,
              record: dictionary.record,
              stop: dictionary.stop,
              recording: dictionary.recording,
              blocked: dictionary.recorderBlocked,
              unsupported: dictionary.recorderUnsupported,
            }}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}
