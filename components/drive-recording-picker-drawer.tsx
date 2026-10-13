"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import {
  CalendarIcon,
  CheckCircle2Icon,
  FileAudioIcon,
  Loader2Icon,
  SearchIcon,
  XCircleIcon,
} from "lucide-react"
import { toast } from "sonner"

import { useI18n } from "@/components/i18n-provider"
import { JOB_STATUS_KEYS } from "@/components/pipeline-timeline"
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
import { apiErrorText } from "@/lib/i18n/api-errors"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { JobRecord } from "@/lib/meetings/repository"

const MAX_SELECTION = 5

const RECORDING_STATUS_KEYS: Record<DriveRecording["status"], string> = {
  available: "opsDriveRecAvailable",
  imported: "opsDriveFileImported",
  processing: "opsMeetingStatusProcessing",
  failed: "opsDriveFileFailed",
}

const FILE_STATUS_KEYS: Record<DriveImportFileResult["status"], string> = {
  imported: "opsDriveFileImported",
  already_imported: "opsDriveFileAlreadyImported",
  queued: "opsDriveFileQueued",
  skipped: "opsDriveFileSkipped",
  failed: "opsDriveFileFailed",
}

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

export function DriveRecordingPickerDrawer({
  open,
  onOpenChange,
  onImported,
}: {
  /** @deprecated Strings come from `useI18n()`; kept for existing callers. */
  dictionary?: Dictionary
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: (result: DriveImportResult) => void
}) {
  const { t, plural, fmt, locale } = useI18n()
  const formatBytes = (value?: number) => {
    if (!value) return t("opsDriveUnknownSize")

    const unit = (amount: number, name: string, digits: number) =>
      fmt.number(amount, { style: "unit", unit: name, unitDisplay: "short", maximumFractionDigits: digits })

    if (value > 1024 * 1024 * 1024) return unit(value / 1024 / 1024 / 1024, "gigabyte", 1)
    if (value > 1024 * 1024) return unit(Math.round(value / 1024 / 1024), "megabyte", 0)
    return unit(Math.round(value / 1024), "kilobyte", 0)
  }
  const [recordings, setRecordings] = useState<DriveRecording[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState("")
  const [error, setError] = useState("")
  const [importing, setImporting] = useState(false)
  const [lastImport, setLastImport] = useState<DriveImportResult | null>(null)
  const [trackedJobs, setTrackedJobs] = useState<Record<string, JobRecord>>({})
  const [loading, startTransition] = useTransition()
  const selectedCount = selected.size

  const selectedIds = useMemo(() => [...selected].slice(0, MAX_SELECTION), [selected])
  const activeImportJobs = useMemo(
    () =>
      (lastImport?.jobs ?? []).filter((job) => {
        const tracked = trackedJobs[job.id] ?? job

        return tracked.status === "queued" || tracked.status === "active"
      }),
    [lastImport?.jobs, trackedJobs]
  )

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
          setError(apiErrorText(body, t, t("opsDriveLoadFailed"), locale))
          return
        }

        setRecordings(body.recordings ?? [])
      })().catch(() => setError(t("opsDriveLoadFailed")))
    })
  }

  useEffect(() => {
    if (!open) return

    const timeoutId = window.setTimeout(() => loadRecordings(""), 0)

    return () => window.clearTimeout(timeoutId)
    // loadRecordings intentionally reads current local state when the drawer opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!lastImport?.jobs.length) return

    const jobIds = new Set(lastImport.jobs.map((job) => job.id))
    let stopped = false

    async function refreshJobs() {
      const response = await fetch("/api/jobs")
      const body = await response.json()

      if (!response.ok || stopped) return

      const nextTracked: Record<string, JobRecord> = {}

      for (const job of body.jobs ?? []) {
        if (jobIds.has(job.id)) nextTracked[job.id] = job
      }

      setTrackedJobs((current) => ({ ...current, ...nextTracked }))
    }

    void refreshJobs()
    const intervalId = window.setInterval(() => void refreshJobs(), 3500)

    return () => {
      stopped = true
      window.clearInterval(intervalId)
    }
  }, [lastImport])

  function toggle(fileId: string) {
    const recording = recordings.find((item) => item.fileId === fileId)

    if (recording && !["available", "failed"].includes(recording.status)) {
      toast.info(
        recording.status === "processing"
          ? t("opsDriveAlreadyProcessing")
          : t("opsDriveAlreadyImported")
      )
      return
    }

    setSelected((current) => {
      const next = new Set(current)

      if (next.has(fileId)) next.delete(fileId)
      else if (next.size < MAX_SELECTION) next.add(fileId)
      else toast.warning(t("opsDriveMaxSelection", { max: MAX_SELECTION }))

      return next
    })
  }

  function importSelected() {
    if (!selectedIds.length) {
      toast.info(t("opsDriveSelectOne"))
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
          toast.error(apiErrorText(body, t, t("opsDriveImportFailed"), locale))
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

        setTrackedJobs(
          Object.fromEntries(importResult.jobs.map((job) => [job.id, job]))
        )
        setLastImport(importResult)
        onImported(importResult)
        setSelected(new Set())

        const failed = importResult.files.filter((file) => file.status === "failed")
        if (importResult.imported > 0) {
          toast.success(plural("opsDriveQueued", importResult.imported))
        } else if (failed.length) {
          toast.error(t("opsDriveImportError"))
        } else {
          toast.info(t("opsDriveNothingImported"))
        }

        loadRecordings()
      } catch {
        toast.error(t("opsDriveImportError"))
      } finally {
        setImporting(false)
      }
    })()
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{t("findDriveRecordings")}</SheetTitle>
          <SheetDescription>{t("opsDriveDescription")}</SheetDescription>
        </SheetHeader>

        <div className="grid gap-4 p-4">
          <div className="flex gap-2">
            <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-surface px-3">
              <SearchIcon aria-hidden="true" className="size-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("opsDriveSearchPlaceholder")}
                aria-label={t("opsDriveSearchPlaceholder")}
                className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
              />
            </div>
            <Button variant="outline" className="h-10" disabled={loading} onClick={() => loadRecordings()}>
              {t("opsDriveSearch")}
            </Button>
          </div>

          {error && (
            <div role="alert" className="rounded-md border border-danger/30 bg-danger-soft p-3 text-sm text-danger-text">
              {error}
            </div>
          )}

          {lastImport && (
            <div className="grid gap-2 rounded-md border border-ring bg-brand-soft p-3 text-sm text-foreground">
              <div className="font-semibold">
                {t("opsDriveImportResult", { queued: lastImport.imported, skipped: lastImport.skipped })}
              </div>
              <div className="grid gap-2 rounded-md border border-line bg-surface p-2 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{t("opsDriveStepDownload")}</span>
                  <span className="flex items-center gap-1 text-ok-text">
                    <CheckCircle2Icon aria-hidden="true" className="size-3.5" />
                    {t("opsDriveStepDone")}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{t("opsDriveStepWorker")}</span>
                  {activeImportJobs.length ? (
                    <span className="flex items-center gap-1 text-brand-text">
                      <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" />
                      {plural("opsDriveActiveJobs", activeImportJobs.length)}
                    </span>
                  ) : lastImport.jobs.some((job) => (trackedJobs[job.id] ?? job).status === "failed") ? (
                    <span className="flex items-center gap-1 text-destructive">
                      <XCircleIcon aria-hidden="true" className="size-3.5" />
                      {t("opsDriveNeedsRetry")}
                    </span>
                  ) : lastImport.jobs.length ? (
                    <span className="flex items-center gap-1 text-ok-text">
                      <CheckCircle2Icon aria-hidden="true" className="size-3.5" />
                      {t("opsDriveStepDone")}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{t("opsDriveNoWorkerJob")}</span>
                  )}
                </div>
              </div>
              <div className="grid gap-1 text-xs">
                {lastImport.files.map((file) => (
                  <div key={`${file.fileId}-${file.jobId ?? file.status}`} className="flex flex-wrap items-center justify-between gap-2">
                    <bdi className="min-w-0 truncate">{file.name ?? file.fileId}</bdi>
                    <span className="rounded-sm bg-surface/85 px-2 py-0.5 font-medium text-brand-text">
                      {t(FILE_STATUS_KEYS[file.status] ?? file.status)}
                      {file.jobId
                        ? ` · ${t(JOB_STATUS_KEYS[trackedJobs[file.jobId]?.status ?? "queued"])}`
                        : ""}
                    </span>
                    {file.jobId && trackedJobs[file.jobId]?.error ? (
                      <span dir="auto" className="basis-full text-destructive">
                        {trackedJobs[file.jobId].error}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          )}

          {(loading || importing) && (
            <div className="rounded-md border border-ring bg-brand-soft p-3 text-sm text-foreground">
              {importing ? t("opsDriveImporting") : t("opsDriveSearching")}
            </div>
          )}

          {!loading && !importing && !error && recordings.length === 0 && (
            <div className="grid min-h-40 place-items-center rounded-md border border-dashed border-line bg-surface-2 p-6 text-center text-sm text-muted-foreground">
              <div>
                <FileAudioIcon aria-hidden="true" className="mx-auto mb-2 size-7 text-brand-text" />
                {t("opsDriveEmpty")}
              </div>
            </div>
          )}

          <div className="grid gap-2">
            {recordings.map((recording) => {
              const canSelect = ["available", "failed"].includes(recording.status)

              return (
              <div
                key={recording.fileId}
                role="button"
                tabIndex={canSelect ? 0 : -1}
                className="grid gap-2 rounded-md border border-line bg-surface p-3 text-start transition hover:border-ring hover:bg-brand-soft/60 data-[selected=true]:border-ring data-[selected=true]:bg-brand-soft data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-70"
                data-selected={selected.has(recording.fileId)}
                data-disabled={!canSelect}
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
                    disabled={!canSelect}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="break-words text-sm font-semibold text-foreground">
                        <bdi>{recording.name}</bdi>
                      </div>
                      <span className="rounded-sm bg-surface-2 px-2 py-0.5 text-2xs font-medium text-muted-foreground">
                        {t(RECORDING_STATUS_KEYS[recording.status] ?? recording.status)}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {recording.mimeType ? <bdi dir="ltr">{recording.mimeType}</bdi> : <span>{t("opsDriveMedia")}</span>}
                      <span>{formatBytes(recording.sizeBytes)}</span>
                      {recording.modifiedTime && (
                        <span>{fmt.date(recording.modifiedTime, "dateTime")}</span>
                      )}
                    </div>
                    {recording.bestCalendarMatch && (
                      <div className="mt-2 flex items-center gap-2 text-xs text-brand-text">
                        <CalendarIcon aria-hidden="true" className="size-3.5" />
                        <span className="truncate">
                          {t("opsDriveMatches", {
                            title: `\u2068${recording.bestCalendarMatch.title}\u2069`,
                            percent: fmt.percent(recording.bestCalendarMatch.confidence),
                          })}
                        </span>
                      </div>
                    )}
                    {recording.artifactHints?.length ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {recording.artifactHints.map((hint) => (
                          <span
                            key={hint}
                            className="rounded-sm bg-brand-soft px-2 py-0.5 text-2xs text-brand-text"
                          >
                            {hint}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  {recording.imported && (
                    <CheckCircle2Icon aria-hidden="true" className="size-4 text-ok" />
                  )}
                </div>
              </div>
            )})}
          </div>
        </div>

        <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-line bg-surface p-4">
          <div className="text-sm text-muted-foreground">
            {importing
              ? t("opsDriveImportInProgress")
              : t("opsDriveSelectedCount", { count: selectedCount, max: MAX_SELECTION })}
          </div>
          <Button className="h-10" disabled={loading || importing || !selectedCount} onClick={importSelected}>
            {importing ? t("opsDriveImportingButton") : t("opsDriveImportButton")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
