"use client"

import { type ChangeEvent, useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import {
  DriveRecordingPickerDrawer,
  type DriveImportResult,
} from "@/components/drive-recording-picker-drawer"
import { MainSidebar, type MainPanelKey } from "@/components/main-sidebar"
import {
  MeetingInboxPanel,
  type MeetingSortMode,
} from "@/components/meeting-inbox-panel"
import { MeetingRightRail } from "@/components/meeting-right-rail"
import { MeetingWorkspace } from "@/components/meeting-workspace"
import { OperationalPage } from "@/components/operational-pages"
import type { ProviderStatusView } from "@/components/provider-health-panel"
import { TopCommandBar, type SyncTarget } from "@/components/top-command-bar"
import type { WorkspaceStatusView } from "@/components/workspace-sync-panel"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"
import type {
  ActionItem,
  JobRecord,
  MeetingRecord,
} from "@/lib/meetings/repository"

function filterMeetings(
  meetings: MeetingRecord[],
  query: string,
  statusFilter: string
) {
  const normalized = query.trim().toLowerCase()

  return meetings
    .filter((meeting) => {
      if (statusFilter === "all") return true
      if (statusFilter === "usable") {
        return [
          "completed",
          "indexing",
          "summarizing",
          "transcribing",
          "media_uploaded",
          "failed",
        ].includes(meeting.status)
      }
      if (statusFilter === "upcoming") {
        return meeting.status === "scheduled"
      }

      return meeting.status === statusFilter
    })
    .filter((meeting) => {
      if (!normalized) return true

      return [
        meeting.title,
        meeting.summary?.overview,
        meeting.source,
        meeting.language,
        ...(meeting.tags ?? []),
        ...(meeting.transcript?.map((segment) => segment.text) ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalized)
    })
}

function sortMeetingsForInbox(meetings: MeetingRecord[], mode: MeetingSortMode = "smart") {
  const rank: Record<string, number> = {
    completed: 0,
    indexing: 1,
    summarizing: 1,
    transcribing: 1,
    media_uploaded: 2,
    media_found: 3,
    media_uploaded_failed: 4,
    failed: 4,
    scheduled: 6,
    created: 7,
  }
  const now = Date.now()

  return [...meetings].sort((left, right) => {
    const leftTime = new Date(left.startedAt).getTime()
    const rightTime = new Date(right.startedAt).getTime()

    if (mode === "recent") return rightTime - leftTime
    if (mode === "oldest") return leftTime - rightTime
    if (mode === "title") return left.title.localeCompare(right.title)
    if (mode === "status") {
      const statusCompare = left.status.localeCompare(right.status)
      if (statusCompare !== 0) return statusCompare
      return rightTime - leftTime
    }

    const leftFuture = left.status === "scheduled" && leftTime > now
    const rightFuture = right.status === "scheduled" && rightTime > now
    const leftRank = leftFuture ? 8 : (rank[left.status] ?? 5)
    const rightRank = rightFuture ? 8 : (rank[right.status] ?? 5)

    if (leftRank !== rightRank) return leftRank - rightRank
    return rightTime - leftTime
  })
}

export function CommandCenterShell({
  dictionary,
  locale,
  meetings,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
  meetings: MeetingRecord[]
}) {
  const router = useRouter()
  const initialMeetings = useMemo(() => sortMeetingsForInbox(meetings), [meetings])
  const [meetingRecords, setMeetingRecords] = useState(initialMeetings)
  const [selectedMeetingId, setSelectedMeetingId] = useState(initialMeetings[0]?.id ?? "")
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [sortMode, setSortMode] = useState<MeetingSortMode>("smart")
  const [activePanel, setActivePanel] = useState<MainPanelKey>("meetings")
  const [askQuestion, setAskQuestion] = useState(dictionary.askDefaultQuestion)
  const [askAnswer, setAskAnswer] = useState("")
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [providers, setProviders] = useState<ProviderStatusView[]>([])
  const [workspaceStatus, setWorkspaceStatus] = useState<WorkspaceStatusView>()
  const [exporting, setExporting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [drivePickerOpen, setDrivePickerOpen] = useState(false)
  const [darkMode, setDarkMode] = useState(false)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    const meetingId = new URLSearchParams(window.location.search).get("meeting")

    if (meetingId && meetings.some((meeting) => meeting.id === meetingId)) {
      queueMicrotask(() => setSelectedMeetingId(meetingId))
    }
  }, [meetings])

  async function refreshOperationalState() {
    const [providersResponse, workspaceResponse, jobsResponse] =
      await Promise.all([
        fetch("/api/ai/providers/status"),
        fetch("/api/workspace/status"),
        fetch("/api/jobs"),
      ])

    if (providersResponse.ok) {
      const body = await providersResponse.json()
      setProviders(body.providers ?? [])
    }
    if (workspaceResponse.ok) {
      const body = await workspaceResponse.json()
      setWorkspaceStatus(body.workspace)
    }
    if (jobsResponse.ok) {
      const body = await jobsResponse.json()
      setJobs(body.jobs ?? [])
    }
  }

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void refreshOperationalState()
    }, 0)
    const intervalId = window.setInterval(() => {
      void refreshOperationalState()
    }, 8000)

    return () => {
      window.clearTimeout(timeoutId)
      window.clearInterval(intervalId)
    }
  }, [])

  useEffect(() => {
    const saved = window.localStorage.getItem("meetsum_theme")
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches
    const enabled = saved ? saved === "dark" : Boolean(prefersDark)

    document.documentElement.classList.toggle("dark", enabled)
    queueMicrotask(() => setDarkMode(enabled))
  }, [])

  function toggleDarkMode() {
    setDarkMode((current) => {
      const next = !current

      document.documentElement.classList.toggle("dark", next)
      window.localStorage.setItem("meetsum_theme", next ? "dark" : "light")

      return next
    })
  }

  const filteredMeetings = useMemo(
    () => sortMeetingsForInbox(filterMeetings(meetingRecords, query, statusFilter), sortMode),
    [meetingRecords, query, sortMode, statusFilter]
  )
  const selectedMeeting =
    meetingRecords.find((meeting) => meeting.id === selectedMeetingId) ??
    filteredMeetings[0] ??
    null

  function selectMeeting(meetingId: string) {
    setSelectedMeetingId(meetingId)
    setActivePanel("meetings")
    const params = new URLSearchParams(window.location.search)

    params.set("meeting", meetingId)
    router.replace(`?${params.toString()}`, { scroll: false })
  }

  async function refreshMeeting(meetingId = selectedMeeting?.id) {
    if (!meetingId) return

    const response = await fetch(`/api/meetings/${meetingId}`)
    const body = await response.json()

    if (!response.ok) {
      throw new Error(body.error ?? "Unable to refresh meeting")
    }

    setMeetingRecords((current) =>
      current.map((meeting) => (meeting.id === meetingId ? body.meeting : meeting))
    )
  }

  async function refreshMeetings(nextSelectedMeetingId?: string) {
    const meetingsResponse = await fetch("/api/meetings")

    if (!meetingsResponse.ok) return

    const meetingsBody = await meetingsResponse.json()
    const nextMeetings = meetingsBody.meetings ?? []

    setMeetingRecords(sortMeetingsForInbox(nextMeetings))
    if (nextSelectedMeetingId) {
      selectMeeting(nextSelectedMeetingId)
    }
  }

  async function createMeetingForFile(file: File) {
    const response = await fetch("/api/meetings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: file.name.replace(/\.[^.]+$/, "") || "Uploaded meeting",
        source: "upload",
        language: "mixed",
        startedAt: new Date().toISOString(),
        participants: [],
      }),
    })
    const body = await response.json()

    if (!response.ok) {
      throw new Error(body.error ?? "Unable to create meeting")
    }

    setMeetingRecords((current) => [body.meeting, ...current])
    setSelectedMeetingId(body.meeting.id)
    setActivePanel("meetings")
    return body.meeting as MeetingRecord
  }

  async function uploadFile(file: File, meeting = selectedMeeting) {
    const targetMeeting = meeting ?? (await createMeetingForFile(file))
    const formData = new FormData()

    formData.set("file", file)

    const response = await fetch(`/api/meetings/${targetMeeting.id}/upload`, {
      method: "POST",
      body: formData,
    })
    const body = await response.json()

    if (!response.ok) {
      throw new Error(body.error ?? "Unable to upload media")
    }

    setJobs((current) => [body.job, ...current])
    toast.success("Upload queued for meeting intelligence")
    await refreshMeeting(targetMeeting.id)
    await refreshOperationalState()
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]

    if (!file) return
    toast.info(`Uploading ${file.name}`)
    startTransition(() =>
      void uploadFile(file).catch((error) => {
        setAskAnswer(error.message)
        toast.error(error.message)
      })
    )
    event.target.value = ""
  }

  function handleRecordingReady(file: File) {
    toast.info("Recording saved. Uploading audio...")
    startTransition(() =>
      void uploadFile(file, selectedMeeting ?? undefined).catch((error) => {
        setAskAnswer(error.message)
        toast.error(error.message)
      })
    )
  }

  async function askMeeting() {
    if (!selectedMeeting) return

    setAskAnswer("")
    const response = await fetch(`/api/meetings/${selectedMeeting.id}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: askQuestion }),
    })
    const body = await response.json()

    if (!response.ok) {
      setAskAnswer(body.error ?? "Unable to ask meeting memory")
      return
    }

    setAskAnswer(body.answer.answer)
    toast.success("Meeting answer ready")
  }

  async function toggleActionItem(item: ActionItem) {
    const response = await fetch(`/api/action-items/${item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: item.status === "done" ? "open" : "done",
      }),
    })
    const body = await response.json()

    if (!response.ok) {
      setAskAnswer(body.error ?? "Unable to update action item")
      return
    }

    await refreshMeeting()
  }

  async function exportRealizeOS() {
    if (!selectedMeeting) return

    setExporting(true)
    try {
      const response = await fetch("/api/integrations/realizeos/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ meetingId: selectedMeeting.id }),
      })
      const body = await response.json()

      if (!response.ok) {
        setAskAnswer(body.error ?? "Unable to export to RealizeOS")
        return
      }

      setJobs((current) => [body.job, ...current])
      toast.success("RealizeOS export queued")
      await refreshMeeting(selectedMeeting.id)
      await refreshOperationalState()
    } finally {
      setExporting(false)
    }
  }

  function reprocessMeeting(mode: "full" | "summary" | "tasks" | "transcript-cleanup") {
    if (!selectedMeeting) return

    startTransition(() => {
      void (async () => {
        const response = await fetch(`/api/meetings/${selectedMeeting.id}/reprocess`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode }),
        })
        const body = await response.json()

        if (!response.ok) {
          toast.error(body.error ?? "Unable to reprocess meeting")
          return
        }

        setJobs((current) => [body.job, ...current])
        toast.success("Reprocess queued")
        await refreshOperationalState()
      })().catch((error) =>
        toast.error(error instanceof Error ? error.message : "Unable to reprocess meeting")
      )
    })
  }

  function syncGoogle(target: SyncTarget) {
    setSyncing(true)
    startTransition(() => {
      void (async () => {
        try {
          const endpoint = `/api/google/sync/${target}`
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ subject: "info@realization.co.il" }),
          })
          const body = await response.json()

          if (!response.ok) {
            setAskAnswer(body.error ?? "Unable to sync Google Workspace")
            toast.error(body.error ?? "Unable to sync Google Workspace")
            return
          }

          setJobs((current) => (body.job ? [body.job, ...current] : current))
          toast.success(target === "gmail" ? "Gmail context sync queued" : "Calendar sync queued")
          await refreshOperationalState()
          await refreshMeetings()
        } finally {
          setSyncing(false)
        }
      })().catch((error) => {
        setSyncing(false)
        toast.error(error instanceof Error ? error.message : "Unable to sync Google Workspace")
      })
    })
  }

  function handleDriveImported(result: DriveImportResult) {
    if (result.jobs.length) {
      setJobs((current) => [...result.jobs, ...current])
    }
    const targetMeetingId = result.files.find((file) => file.meetingId)?.meetingId

    if (result.errors.length) {
      toast.error(result.errors[0])
    }
    if (targetMeetingId) {
      void refreshMeetings(targetMeetingId)
    }
    void refreshOperationalState()
  }

  function retryJob(job: JobRecord) {
    startTransition(() => {
      void (async () => {
        const response = await fetch(`/api/jobs/${job.id}/retry`, {
          method: "POST",
        })
        const body = await response.json()

        if (!response.ok) {
          setAskAnswer(body.error ?? "Unable to retry job")
          return
        }

        setJobs((current) => [body.job, ...current])
      })()
    })
  }

  const defaultMeetingsView = (
    <div className="grid min-h-[calc(100svh-4rem)] grid-cols-1 bg-slate-50 lg:grid-cols-[348px_minmax(0,1fr)] 2xl:grid-cols-[348px_minmax(0,1fr)_272px]">
      <MeetingInboxPanel
        dictionary={dictionary}
        locale={locale}
        meetings={filteredMeetings}
        selectedMeetingId={selectedMeeting?.id}
        query={query}
        activeFilter={statusFilter}
        sortMode={sortMode}
        onQueryChange={setQuery}
        onFilterChange={setStatusFilter}
        onSortChange={setSortMode}
        onSelectMeeting={selectMeeting}
      />
      <MeetingWorkspace
        dictionary={dictionary}
        locale={locale}
        meeting={selectedMeeting}
        question={askQuestion}
        answer={askAnswer}
        asking={isPending}
        onQuestionChange={setAskQuestion}
        onAsk={askMeeting}
        onToggleActionItem={toggleActionItem}
        onReprocessMeeting={reprocessMeeting}
        onOpenUpload={() => setUploadOpen(true)}
        onSyncGoogle={() => syncGoogle("calendar")}
        onCheckSetup={() => setActivePanel("workspace")}
      />
      <MeetingRightRail
        meeting={selectedMeeting}
        jobs={jobs}
        exporting={exporting}
        onExportRealizeOS={exportRealizeOS}
      />
    </div>
  )

  return (
    <main className="min-h-svh bg-[var(--surface-subtle)] text-foreground">
      <div className="grid min-h-svh grid-cols-1 lg:grid-cols-[206px_minmax(0,1fr)]">
        <MainSidebar
          dictionary={dictionary}
          activePanel={activePanel}
          onPanelChange={setActivePanel}
        />
        <section className="min-w-0">
          <TopCommandBar
            dictionary={dictionary}
            locale={locale}
            query={query}
            pending={isPending}
            syncing={syncing}
            uploadOpen={uploadOpen}
            onQueryChange={setQuery}
            onUploadOpenChange={setUploadOpen}
            onFileChange={handleFileChange}
            onRecordingReady={handleRecordingReady}
            onSync={syncGoogle}
            onFindDriveRecordings={() => setDrivePickerOpen(true)}
            darkMode={darkMode}
            onToggleDarkMode={toggleDarkMode}
          />
          <DriveRecordingPickerDrawer
            open={drivePickerOpen}
            onOpenChange={setDrivePickerOpen}
            onImported={handleDriveImported}
          />
          {activePanel === "meetings"
            ? defaultMeetingsView
            : (
                <OperationalPage
                  panel={activePanel}
                  meetings={meetingRecords}
                  jobs={jobs}
                  providers={providers}
                  workspaceStatus={workspaceStatus}
                  syncing={syncing}
                  query={query}
                  onQueryChange={setQuery}
                  onSyncCalendar={() => syncGoogle("calendar")}
                  onFindDriveRecordings={() => setDrivePickerOpen(true)}
                  onRetryJob={retryJob}
                />
              )}
        </section>
      </div>
    </main>
  )
}
