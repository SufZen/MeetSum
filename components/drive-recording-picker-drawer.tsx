"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { CalendarIcon, CheckCircle2Icon, FileAudioIcon, SearchIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type { JobRecord } from "@/lib/meetings/repository"

type DriveRecording = {
  fileId: string
  name: string
  mimeType?: string
  sizeBytes?: number
  modifiedTime?: string
  imported: boolean
  importedMeetingId?: string
  bestCalendarMatch?: {
    title: string
    confidence: number
    matchMethod: string
  }
}

function formatBytes(value?: number) {
  if (!value) return "Unknown size"
  if (value > 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (value > 1024 * 1024) return `${Math.round(value / 1024 / 1024)} MB`
  return `${Math.round(value / 1024)} KB`
}

export function DriveRecordingPickerDrawer({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: (jobs: JobRecord[]) => void
}) {
  const [recordings, setRecordings] = useState<DriveRecording[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState("")
  const [error, setError] = useState("")
  const [loading, startTransition] = useTransition()
  const selectedCount = selected.size

  const selectedIds = useMemo(() => [...selected].slice(0, 5), [selected])

  function loadRecordings(nextQuery = query) {
    setError("")
    startTransition(() => {
      void (async () => {
        const params = new URLSearchParams({
          limit: "25",
          includeImported: "false",
        })

        if (nextQuery.trim()) params.set("query", nextQuery.trim())

        const response = await fetch(`/api/google/drive/recordings?${params}`)
        const body = await response.json()

        if (!response.ok) {
          setError(body.error ?? "Unable to find Drive recordings")
          return
        }

        setRecordings(body.recordings ?? [])
      })().catch((caught) =>
        setError(caught instanceof Error ? caught.message : "Unable to find Drive recordings")
      )
    })
  }

  useEffect(() => {
    if (!open) return

    const timeoutId = window.setTimeout(() => loadRecordings(""), 0)

    return () => window.clearTimeout(timeoutId)
    // loadRecordings intentionally reads current local state when the drawer opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function toggle(fileId: string) {
    setSelected((current) => {
      const next = new Set(current)

      if (next.has(fileId)) next.delete(fileId)
      else if (next.size < 5) next.add(fileId)
      else toast.warning("Import up to 5 recordings at a time")

      return next
    })
  }

  function importSelected() {
    if (!selectedIds.length) {
      toast.info("Select at least one Drive recording")
      return
    }

    startTransition(() => {
      void (async () => {
        const response = await fetch("/api/google/drive/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fileIds: selectedIds }),
        })
        const body = await response.json()

        if (!response.ok) {
          toast.error(body.error ?? "Unable to import selected recordings")
          return
        }

        onImported(body.jobs ?? [])
        setSelected(new Set())
        toast.success(`Queued ${body.imported ?? 0} Drive recording(s)`)
        loadRecordings()
      })().catch((caught) =>
        toast.error(caught instanceof Error ? caught.message : "Drive import failed")
      )
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Find Drive recordings</SheetTitle>
          <SheetDescription>
            Select recordings to import. MeetSum lists candidates first and only downloads files you choose.
          </SheetDescription>
        </SheetHeader>

        <div className="grid gap-4 p-4">
          <div className="flex gap-2">
            <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-md border bg-white px-3">
              <SearchIcon aria-hidden="true" className="size-4 text-slate-500" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search Drive recordings"
                className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
              />
            </div>
            <Button variant="outline" className="h-10" disabled={loading} onClick={() => loadRecordings()}>
              Search
            </Button>
          </div>

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {error}
            </div>
          )}

          {!loading && !error && recordings.length === 0 && (
            <div className="grid min-h-40 place-items-center rounded-md border border-dashed bg-slate-50 p-6 text-center text-sm text-slate-600">
              <div>
                <FileAudioIcon aria-hidden="true" className="mx-auto mb-2 size-7 text-teal-700" />
                No unimported Drive recordings found.
              </div>
            </div>
          )}

          <div className="grid gap-2">
            {recordings.map((recording) => (
              <div
                key={recording.fileId}
                role="button"
                tabIndex={0}
                className="grid gap-2 rounded-md border bg-white p-3 text-left transition hover:border-teal-300 hover:bg-cyan-50/30 data-[selected=true]:border-teal-500 data-[selected=true]:bg-cyan-50 rtl:text-right"
                data-selected={selected.has(recording.fileId)}
                onClick={() => toggle(recording.fileId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    toggle(recording.fileId)
                  }
                }}
              >
                <div className="flex items-start gap-3">
                  <Checkbox
                    checked={selected.has(recording.fileId)}
                    onCheckedChange={() => toggle(recording.fileId)}
                    onClick={(event) => event.stopPropagation()}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="break-words text-sm font-semibold text-slate-950">
                      {recording.name}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
                      <span>{recording.mimeType ?? "media"}</span>
                      <span>{formatBytes(recording.sizeBytes)}</span>
                      {recording.modifiedTime && (
                        <span>{new Date(recording.modifiedTime).toLocaleString()}</span>
                      )}
                    </div>
                    {recording.bestCalendarMatch && (
                      <div className="mt-2 flex items-center gap-2 text-xs text-teal-800">
                        <CalendarIcon aria-hidden="true" className="size-3.5" />
                        <span className="truncate">
                          Matches {recording.bestCalendarMatch.title} ·{" "}
                          {Math.round(recording.bestCalendarMatch.confidence * 100)}%
                        </span>
                      </div>
                    )}
                  </div>
                  {recording.imported && (
                    <CheckCircle2Icon aria-hidden="true" className="size-4 text-emerald-600" />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t bg-white p-4">
          <div className="text-sm text-slate-600">{selectedCount}/5 selected</div>
          <Button className="h-10" disabled={loading || !selectedCount} onClick={importSelected}>
            Import selected
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
