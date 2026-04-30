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
  status: "available" | "imported" | "processing" | "failed"
  imported: boolean
  importedMeetingId?: string
  meetingId?: string
  jobId?: string
  artifactHints?: string[]
  bestCalendarMatch?: {
    title: string
    confidence: number
    matchMethod: string
  }
}

export type DriveImportFileResult = {
  fileId: string
  name?: string
  status: "imported" | "already_imported" | "queued" | "skipped" | "failed"
  meetingId?: string
  jobId?: string
  error?: string
}

export type DriveImportResult = {
  imported: number
  skipped: number
  matched: number
  jobs: JobRecord[]
  errors: string[]
  files: DriveImportFileResult[]
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
  onImported: (result: DriveImportResult) => void
}) {
  const [recordings, setRecordings] = useState<DriveRecording[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState("")
  const [error, setError] = useState("")
  const [importing, setImporting] = useState(false)
  const [lastImport, setLastImport] = useState<DriveImportResult | null>(null)
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

    setImporting(true)
    void (async () => {
      try {
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

        const importResult: DriveImportResult = {
          imported: body.imported ?? 0,
          skipped: body.skipped ?? 0,
          matched: body.matched ?? 0,
          jobs: body.jobs ?? [],
          errors: body.errors ?? [],
          files: body.files ?? [],
        } satisfies DriveImportResult

        setLastImport(importResult)
        onImported(importResult)
        setSelected(new Set())

        const failed = importResult.files.filter((file) => file.status === "failed")
        if (importResult.imported > 0) {
          toast.success(`Queued ${importResult.imported} Drive recording(s)`)
        } else if (failed.length) {
          toast.error(failed[0]?.error ?? "Drive import failed")
        } else {
          toast.info("No new recordings were imported")
        }

        loadRecordings()
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : "Drive import failed")
      } finally {
        setImporting(false)
      }
    })()
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
            <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-md border border-[var(--divider)] bg-[var(--surface)] px-3">
              <SearchIcon aria-hidden="true" className="size-4 text-muted-foreground" />
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

          {lastImport && (
            <div className="grid gap-2 rounded-md border border-[var(--focus)] bg-[var(--selected)] p-3 text-sm text-foreground">
              <div className="font-semibold">
                Import result: {lastImport.imported} queued, {lastImport.skipped} skipped
              </div>
              <div className="grid gap-1 text-xs">
                {lastImport.files.map((file) => (
                  <div key={`${file.fileId}-${file.jobId ?? file.status}`} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 truncate">{file.name ?? file.fileId}</span>
                    <span className="rounded-sm bg-[var(--surface)]/85 px-2 py-0.5 font-medium text-[var(--primary)]">
                      {file.status}
                      {file.jobId ? ` · ${file.jobId.slice(0, 8)}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(loading || importing) && (
            <div className="rounded-md border border-[var(--focus)] bg-[var(--selected)] p-3 text-sm text-foreground">
              {importing
                ? "Importing selected recording(s): downloading from Drive, storing in MinIO, and queueing processing..."
                : "Searching Drive recordings..."}
            </div>
          )}

          {!loading && !importing && !error && recordings.length === 0 && (
            <div className="grid min-h-40 place-items-center rounded-md border border-dashed border-[var(--divider)] bg-[var(--surface-subtle)] p-6 text-center text-sm text-muted-foreground">
              <div>
                <FileAudioIcon aria-hidden="true" className="mx-auto mb-2 size-7 text-[var(--primary)]" />
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
                className="grid gap-2 rounded-md border border-[var(--divider)] bg-[var(--surface)] p-3 text-left transition hover:border-[var(--focus)] hover:bg-[var(--selected)]/60 data-[selected=true]:border-[var(--focus)] data-[selected=true]:bg-[var(--selected)] disabled:cursor-not-allowed disabled:opacity-70 rtl:text-right"
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
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="break-words text-sm font-semibold text-foreground">
                        {recording.name}
                      </div>
                      <span className="rounded-sm bg-[var(--muted)] px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                        {recording.status}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>{recording.mimeType ?? "media"}</span>
                      <span>{formatBytes(recording.sizeBytes)}</span>
                      {recording.modifiedTime && (
                        <span>{new Date(recording.modifiedTime).toLocaleString()}</span>
                      )}
                    </div>
                    {recording.bestCalendarMatch && (
                      <div className="mt-2 flex items-center gap-2 text-xs text-[var(--primary)]">
                        <CalendarIcon aria-hidden="true" className="size-3.5" />
                        <span className="truncate">
                          Matches {recording.bestCalendarMatch.title} ·{" "}
                          {Math.round(recording.bestCalendarMatch.confidence * 100)}%
                        </span>
                      </div>
                    )}
                    {recording.artifactHints?.length ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {recording.artifactHints.map((hint) => (
                          <span
                            key={hint}
                            className="rounded-sm bg-[var(--selected)] px-2 py-0.5 text-[11px] text-[var(--primary)]"
                          >
                            {hint}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  {recording.imported && (
                    <CheckCircle2Icon aria-hidden="true" className="size-4 text-emerald-600" />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-[var(--divider)] bg-[var(--surface)] p-4">
          <div className="text-sm text-muted-foreground">
            {importing ? "Import in progress..." : `${selectedCount}/5 selected`}
          </div>
          <Button className="h-10" disabled={loading || importing || !selectedCount} onClick={importSelected}>
            {importing ? "Importing and queueing..." : "Import selected to processing"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
