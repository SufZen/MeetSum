"use client"

import { lazy, Suspense, useEffect, useState, type ChangeEvent } from "react"
import { LaptopIcon, MicIcon, UploadIcon } from "lucide-react"

import type { BrowserRecorder } from "@/components/bot/use-browser-recorder"
import { Button } from "@/components/ui/button"
import type { Dictionary } from "@/lib/i18n/dictionaries"

// M10 C bundle diet: the sheet (dialog primitives, floating focus manager,
// the recorder UI) is its own chunk. It loads on hover/focus of a trigger, on
// first open, and otherwise once the browser is idle, so the recorder sheet
// still opens after the connection drops (the SW keeps the hashed chunk).
const loadSheet = () => import("@/components/media-ingestion-sheet")
const MediaIngestionSheet = lazy(() => loadSheet().then((mod) => ({ default: mod.MediaIngestionSheet })))
const preloadSheet = () => void loadSheet().catch(() => undefined)

export function MediaIngestionDrawer({
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
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void
  onRecordingReady: (file: File) => void
  /** The shell's browser recorder (M7): keeps recording, and the dock, when the sheet closes. */
  recorder?: BrowserRecorder
  /** Meeting the browser recording belongs to, for the dock's "Open meeting". */
  meetingId?: string | null
}) {
  const [innerOpen, setInnerOpen] = useState(false)
  const isOpen = open ?? innerOpen
  // Mounted on first open and kept (close animation, recorder state).
  const [mounted, setMounted] = useState(false)

  if (isOpen && !mounted) setMounted(true)

  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((callback: () => void) => window.setTimeout(callback, 2000))
    const cancel = window.cancelIdleCallback ?? window.clearTimeout
    const id = idle(preloadSheet)

    return () => cancel(id)
  }, [])

  function setOpen(next: boolean) {
    if (open === undefined) setInnerOpen(next)
    onOpenChange?.(next)
  }

  const triggerLabel =
    mode === "record"
      ? dictionary.recordOnComputer
      : mode === "desktop"
        ? dictionary.opsIngestDesktopTrigger
        : dictionary.upload
  const TriggerIcon =
    mode === "record" ? MicIcon : mode === "desktop" ? LaptopIcon : UploadIcon

  return (
    <>
      {/* One primary action per view (Cadence §7): upload stays primary,
          recording uses the live `record` treatment, desktop import is secondary. */}
      <Button
        className="h-9"
        disabled={pending}
        variant={mode === "record" ? "record" : mode === "desktop" ? "secondary" : "default"}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onPointerEnter={preloadSheet}
        onFocus={preloadSheet}
        onClick={() => setOpen(true)}
      >
        <TriggerIcon data-icon="inline-start" />
        {triggerLabel}
      </Button>
      {mounted ? (
        <Suspense fallback={null}>
          <MediaIngestionSheet
            dictionary={dictionary}
            pending={pending}
            mode={mode}
            open={isOpen}
            onOpenChange={setOpen}
            onFileChange={onFileChange}
            onRecordingReady={onRecordingReady}
            recorder={recorder}
            meetingId={meetingId}
          />
        </Suspense>
      ) : null}
    </>
  )
}
