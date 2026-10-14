"use client"

import type { ChangeEvent } from "react"
import { LaptopIcon, MicIcon, UploadIcon } from "lucide-react"

import type { BrowserRecorder } from "@/components/bot/use-browser-recorder"
import { MeetingRecorder } from "@/components/meeting-recorder"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type { Dictionary } from "@/lib/i18n/dictionaries"

/**
 * The upload / record / desktop-import sheet body. Loaded by
 * `MediaIngestionDrawer` on first open (or on idle), M10 C bundle diet.
 */
export function MediaIngestionSheet({
  dictionary,
  pending,
  mode = "upload",
  open,
  onOpenChange,
  onFileChange,
  onRecordingReady,
  recorder,
  meetingId,
}: {
  dictionary: Dictionary
  pending?: boolean
  mode?: "upload" | "record" | "desktop"
  open: boolean
  onOpenChange: (open: boolean) => void
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void
  onRecordingReady: (file: File) => void
  /** The shell's browser recorder (M7): keeps recording, and the dock, when the sheet closes. */
  recorder?: BrowserRecorder
  /** Meeting the browser recording belongs to, for the dock's "Open meeting". */
  meetingId?: string | null
}) {
  const TriggerIcon =
    mode === "record" ? MicIcon : mode === "desktop" ? LaptopIcon : UploadIcon
  const title =
    mode === "record"
      ? dictionary.recordOnComputer
      : mode === "desktop"
        ? dictionary.opsIngestDesktopTitle
        : dictionary.opsIngestUploadTitle
  const description =
    mode === "record"
      ? dictionary.opsIngestRecordDescription
      : mode === "desktop"
        ? dictionary.opsIngestDesktopDescription
        : dictionary.opsIngestUploadDescription

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="grid gap-4 p-4">
          {pending && (
            <div className="rounded-md border border-ring bg-brand-soft p-3 text-sm text-foreground">
              {dictionary.opsIngestPending}
            </div>
          )}
          {(mode === "upload" || mode === "desktop") && (
            <label className="grid min-h-36 cursor-pointer place-items-center rounded-md border border-dashed bg-muted/40 p-6 text-center text-sm text-muted-foreground">
              <TriggerIcon aria-hidden="true" className="mb-2 size-6 text-primary" />
              <span className="font-medium text-foreground">
                {mode === "desktop"
                  ? dictionary.opsIngestChooseDesktop
                  : dictionary.opsIngestChooseMedia}
              </span>
              <span>
                {mode === "desktop"
                  ? dictionary.opsIngestDesktopHint
                  : dictionary.opsIngestUploadHint}
              </span>
              <input
                type="file"
                className="hidden"
                accept="audio/*,video/*"
                onChange={onFileChange}
              />
            </label>
          )}
          {mode === "record" ? (
            <MeetingRecorder
              onRecordingReady={onRecordingReady}
              recorder={recorder}
              meetingId={meetingId}
              labels={{
                ready: dictionary.recorderReady,
                record: dictionary.record,
                stop: dictionary.stop,
                recording: dictionary.recording,
                blocked: dictionary.recorderBlocked,
                unsupported: dictionary.recorderUnsupported,
              }}
            />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
