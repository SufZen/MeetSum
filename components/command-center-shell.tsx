"use client"

import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react"
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
import { Button } from "@/components/ui/button"
import { TopCommandBar, type SyncTarget } from "@/components/top-command-bar"
import type { WorkspaceStatusView } from "@/components/workspace-sync-panel"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"
import type {
  ActionItem,
  JobRecord,
  MeetingParticipant,
  MeetingRecord,
} from "@/lib/meetings/repository"

type MeetingPageState = {
  limit: number
  offset: number
  total: number
  hasMore: boolean
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
  const initialMeetings = useMemo(() => meetings, [meetings])
  const [meetingRecords, setMeetingRecords] = useState(initialMeetings)
  const [selectedMeetingId, setSelectedMeetingId] = useState(initialMeetings[0]?.id ?? "")
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [sortMode, setSortMode] = useState<MeetingSortMode>("smart")
  const [pageSize, setPageSize] = useState(5)
  const [pageOffset, setPageOffset] = useState(0)
  const [meetingPage, setMeetingPage] = useState<MeetingPageState>({
    limit: 5,
    offset: 0,
    total: initialMeetings.length,
    hasMore: false,
  })
  const [meetingsLoading, setMeetingsLoading] = useState(false)
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
  const [shareOpen, setShareOpen] = useState(false)
  const [shareLink, setShareLink] = useState("")
  const [participantsOpen, setParticipantsOpen] = useState(false)
  const [participants, setParticipants] = useState<MeetingParticipant[]>([])
  const [tagsOpen, setTagsOpen] = useState(false)
  const [tagDraft, setTagDraft] = useState("")
  const [darkMode, setDarkMode] = useState(false)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    const meetingId = new URLSearchParams(window.location.search).get("meeting")

    if (meetingId && meetingRecords.some((meeting) => meeting.id === meetingId)) {
      queueMicrotask(() => setSelectedMeetingId(meetingId))
    }
  }, [meetingRecords])

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
    const enabled = saved ? saved === "dark" : false

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

  const selectedMeeting =
    meetingRecords.find((meeting) => meeting.id === selectedMeetingId) ??
    meetingRecords[0] ??
    null

  const selectMeeting = useCallback((meetingId: string) => {
    setSelectedMeetingId(meetingId)
    setActivePanel("meetings")
    const params = new URLSearchParams(window.location.search)

    params.set("meeting", meetingId)
    router.replace(`?${params.toString()}`, { scroll: false })
  }, [router])

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

  const refreshMeetings = useCallback(async (nextSelectedMeetingId?: string) => {
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(pageOffset),
      sort: sortMode,
      status: statusFilter,
    })

    if (query.trim()) {
      params.set("query", query.trim())
    }

    setMeetingsLoading(true)
    const meetingsResponse = await fetch(`/api/meetings?${params.toString()}`)

    if (!meetingsResponse.ok) {
      setMeetingsLoading(false)
      return
    }

    const meetingsBody = await meetingsResponse.json()
    const nextMeetings = meetingsBody.meetings ?? []

    setMeetingRecords(nextMeetings)
    setMeetingPage(
      meetingsBody.page ?? {
        limit: pageSize,
        offset: pageOffset,
        total: nextMeetings.length,
        hasMore: false,
      }
    )
    setMeetingsLoading(false)
    if (nextSelectedMeetingId) {
      selectMeeting(nextSelectedMeetingId)
    } else if (
      nextMeetings.length &&
      !nextMeetings.some((meeting: MeetingRecord) => meeting.id === selectedMeetingId)
    ) {
      setSelectedMeetingId(nextMeetings[0].id)
    }
  }, [
    pageOffset,
    pageSize,
    query,
    selectMeeting,
    selectedMeetingId,
    sortMode,
    statusFilter,
  ])

  useEffect(() => {
    const timeoutId = window.setTimeout(
      () => void refreshMeetings(),
      query.trim() ? 250 : 0
    )

    return () => window.clearTimeout(timeoutId)
  }, [refreshMeetings, query])

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

    setMeetingRecords((current) => [body.meeting, ...current].slice(0, pageSize))
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

  async function copyText(text: string, label: string) {
    if (!text.trim()) {
      toast.info(`${label} is empty`)
      return
    }

    await navigator.clipboard.writeText(text)
    toast.success(`${label} copied`)
  }

  async function openShareDialog() {
    if (!selectedMeeting) return

    setShareOpen(true)
    const response = await fetch(`/api/meetings/${selectedMeeting.id}/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    const body = await response.json()

    if (!response.ok) {
      toast.error(body.error ?? "Unable to create share link")
      return
    }

    setShareLink(body.url)
  }

  async function regenerateShareLink() {
    if (!selectedMeeting) return

    const response = await fetch(`/api/meetings/${selectedMeeting.id}/share`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ regenerate: true }),
    })
    const body = await response.json()

    if (!response.ok) {
      toast.error(body.error ?? "Unable to regenerate share link")
      return
    }

    setShareLink(body.url)
    toast.success("Share link regenerated")
  }

  async function revokeShareLink() {
    if (!selectedMeeting) return

    const response = await fetch(`/api/meetings/${selectedMeeting.id}/share`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revoked: true }),
    })
    const body = await response.json()

    if (!response.ok) {
      toast.error(body.error ?? "Unable to revoke share link")
      return
    }

    setShareLink("")
    toast.success("Share link revoked")
  }

  async function toggleFavorite() {
    if (!selectedMeeting) return

    const response = await fetch(`/api/meetings/${selectedMeeting.id}/favorite`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorite: !selectedMeeting.isFavorite }),
    })
    const body = await response.json()

    if (!response.ok) {
      toast.error(body.error ?? "Unable to update favorite")
      return
    }

    setMeetingRecords((current) =>
      current.map((meeting) =>
        meeting.id === selectedMeeting.id ? body.meeting : meeting
      )
    )
  }

  async function openParticipantsDialog() {
    if (!selectedMeeting) return

    setParticipantsOpen(true)
    const response = await fetch(
      `/api/meetings/${selectedMeeting.id}/participants`
    )
    const body = await response.json()

    if (!response.ok) {
      toast.error(body.error ?? "Unable to load participants")
      return
    }

    setParticipants(body.participants ?? [])
  }

  async function saveParticipant(participant: MeetingParticipant) {
    const response = await fetch(
      `/api/meetings/${participant.meetingId}/participants/${participant.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(participant),
      }
    )
    const body = await response.json()

    if (!response.ok) {
      toast.error(body.error ?? "Unable to save participant")
      return
    }

    setParticipants((current) =>
      current.map((item) => (item.id === participant.id ? body.participant : item))
    )
    await refreshMeeting(participant.meetingId)
    toast.success("Participant updated")
  }

  function openTagsDialog() {
    if (!selectedMeeting) return

    setTagDraft((selectedMeeting.tags ?? []).join(", "))
    setTagsOpen(true)
  }

  async function saveTags() {
    if (!selectedMeeting) return

    const response = await fetch(`/api/meetings/${selectedMeeting.id}/tags`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tags: tagDraft
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      }),
    })
    const body = await response.json()

    if (!response.ok) {
      toast.error(body.error ?? "Unable to save tags")
      return
    }

    setMeetingRecords((current) =>
      current.map((meeting) =>
        meeting.id === selectedMeeting.id ? body.meeting : meeting
      )
    )
    setTagsOpen(false)
    toast.success("Tags updated")
  }

  async function addToDefaultRoom() {
    if (!selectedMeeting) return

    const contextsResponse = await fetch("/api/contexts")
    const contextsBody = await contextsResponse.json()
    let contextId = contextsBody.contexts?.find(
      (context: { name: string }) => context.name === "Real Estate Acquisitions"
    )?.id

    if (!contextId) {
      const response = await fetch("/api/contexts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Real Estate Acquisitions" }),
      })
      const body = await response.json()

      if (!response.ok || !body.context?.id) {
        toast.error(body.error ?? "Unable to create room")
        return
      }
      contextId = body.context.id
    }

    const linkResponse = await fetch(
      `/api/meetings/${selectedMeeting.id}/contexts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contextId }),
      }
    )
    const linkBody = await linkResponse.json()

    if (!linkResponse.ok) {
      toast.error(linkBody.error ?? "Unable to add meeting to room")
      return
    }

    await refreshMeeting(selectedMeeting.id)
    toast.success("Meeting added to room")
  }

  async function downloadExport(format: "pdf" | "markdown") {
    if (!selectedMeeting) return

    const response = await fetch(
      `/api/meetings/${selectedMeeting.id}/export/${format}`,
      { method: "POST" }
    )

    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      toast.error(body.error ?? `Unable to export ${format}`)
      return
    }

    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    const extension = format === "pdf" ? "pdf" : "md"

    anchor.href = url
    anchor.download = `${selectedMeeting.title.replace(/[^a-z0-9_-]+/gi, "-")}.${extension}`
    anchor.click()
    URL.revokeObjectURL(url)
    toast.success(`${format.toUpperCase()} exported`)
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

  function processMeeting() {
    if (!selectedMeeting) return

    startTransition(() => {
      void (async () => {
        const response = await fetch(`/api/meetings/${selectedMeeting.id}/process`, {
          method: "POST",
        })
        const body = await response.json()

        if (!response.ok) {
          toast.error(body.error ?? "Unable to process meeting")
          return
        }

        setJobs((current) => [body.job, ...current])
        toast.success(body.message ?? "Processing queued")
        await refreshMeeting(selectedMeeting.id)
        await refreshOperationalState()
      })().catch((error) =>
        toast.error(error instanceof Error ? error.message : "Unable to process meeting")
      )
    })
  }

  function syncMeetArtifacts() {
    setSyncing(true)
    startTransition(() => {
      void (async () => {
        try {
          const response = await fetch("/api/google/meet/sync", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ subject: "info@realization.co.il" }),
          })
          const body = await response.json()

          if (!response.ok) {
            toast.error(body.error ?? "Unable to sync Meet artifacts")
            return
          }

          toast.success(body.message ?? "Meet artifact sync checked")
          await refreshOperationalState()
        } finally {
          setSyncing(false)
        }
      })().catch((error) => {
        setSyncing(false)
        toast.error(error instanceof Error ? error.message : "Unable to sync Meet artifacts")
      })
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
    <div className="grid min-h-[calc(100svh-3.5rem)] grid-cols-1 bg-[var(--surface-subtle)] lg:h-[calc(100svh-3.5rem)] lg:min-h-0 lg:overflow-hidden lg:grid-cols-[330px_minmax(0,1fr)] 2xl:grid-cols-[330px_minmax(0,1fr)_270px]">
      <MeetingInboxPanel
        dictionary={dictionary}
        locale={locale}
        meetings={meetingRecords}
        selectedMeetingId={selectedMeeting?.id}
        query={query}
        activeFilter={statusFilter}
        sortMode={sortMode}
        loading={meetingsLoading}
        page={meetingPage}
        pageSize={pageSize}
        onQueryChange={(value) => {
          setQuery(value)
          setPageOffset(0)
        }}
        onFilterChange={(value) => {
          setStatusFilter(value)
          setPageOffset(0)
        }}
        onSortChange={(value) => {
          setSortMode(value)
          setPageOffset(0)
        }}
        onPageSizeChange={(value) => {
          setPageSize(value)
          setPageOffset(0)
        }}
        onPreviousPage={() => setPageOffset((current) => Math.max(0, current - pageSize))}
        onNextPage={() => {
          if (meetingPage.hasMore) setPageOffset((current) => current + pageSize)
        }}
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
        onProcessMeeting={processMeeting}
        onOpenUpload={() => setUploadOpen(true)}
        onFindDriveRecordings={() => setDrivePickerOpen(true)}
        onSyncMeetArtifacts={syncMeetArtifacts}
        onSyncGoogle={() => syncGoogle("calendar")}
        onCheckSetup={() => setActivePanel("workspace")}
        onShareMeeting={openShareDialog}
        onToggleFavorite={toggleFavorite}
        onShowParticipants={openParticipantsDialog}
        onAddToRoom={addToDefaultRoom}
        onCopyText={copyText}
      />
      <MeetingRightRail
        meeting={selectedMeeting}
        jobs={jobs}
        exporting={exporting}
        onEditTags={openTagsDialog}
        onExportMarkdown={() => downloadExport("markdown")}
        onExportPdf={() => downloadExport("pdf")}
        onExportRealizeOS={exportRealizeOS}
      />
    </div>
  )

  return (
    <main className="ms-page min-h-svh lg:fixed lg:inset-0 lg:h-svh lg:overflow-hidden">
      <div className="grid min-h-svh grid-cols-1 lg:h-svh lg:min-h-0 lg:grid-cols-[220px_minmax(0,1fr)] lg:overflow-hidden">
        <MainSidebar
          dictionary={dictionary}
          activePanel={activePanel}
          onPanelChange={setActivePanel}
        />
        <section className="min-w-0 lg:h-svh lg:overflow-hidden">
          <TopCommandBar
            dictionary={dictionary}
            locale={locale}
            query={query}
            pending={isPending}
            syncing={syncing}
            uploadOpen={uploadOpen}
            onQueryChange={(value) => {
              setQuery(value)
              setPageOffset(0)
            }}
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
          {shareOpen ? (
            <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4">
              <section className="w-full max-w-lg rounded-lg border border-[var(--divider)] bg-[var(--surface)] p-5 shadow-xl">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">Share meeting</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Public link includes summary, decisions, action items,
                      participants, and transcript. Audio remains private.
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setShareOpen(false)}>
                    Close
                  </Button>
                </div>
                <div className="mt-4 rounded-md border border-[var(--divider)] bg-[var(--surface-subtle)] p-3">
                  <input
                    className="w-full bg-transparent text-sm outline-none"
                    readOnly
                    value={shareLink || "Creating link..."}
                  />
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    disabled={!shareLink}
                    onClick={() => copyText(shareLink, "Share link")}
                  >
                    Copy link
                  </Button>
                  <Button
                    disabled={!shareLink}
                    variant="outline"
                    onClick={() => window.open(shareLink, "_blank")}
                  >
                    Open
                  </Button>
                  <Button variant="outline" onClick={regenerateShareLink}>
                    Regenerate
                  </Button>
                  <Button variant="destructive" onClick={revokeShareLink}>
                    Revoke
                  </Button>
                </div>
              </section>
            </div>
          ) : null}
          {participantsOpen ? (
            <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4">
              <section className="w-full max-w-2xl rounded-lg border border-[var(--divider)] bg-[var(--surface)] p-5 shadow-xl">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">Participants</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Edit attendee names and map speakers when transcript
                      labels need cleanup.
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setParticipantsOpen(false)}
                  >
                    Close
                  </Button>
                </div>
                <div className="mt-4 max-h-[55vh] space-y-3 overflow-y-auto">
                  {participants.length ? participants.map((participant) => (
                    <div
                      className="grid gap-2 rounded-md border border-[var(--divider)] p-3 md:grid-cols-[1fr_1fr_110px_auto]"
                      key={participant.id}
                    >
                      <input
                        className="rounded-md border border-[var(--divider)] bg-[var(--surface)] px-3 py-2 text-sm"
                        value={participant.name}
                        onChange={(event) =>
                          setParticipants((current) =>
                            current.map((item) =>
                              item.id === participant.id
                                ? { ...item, name: event.target.value }
                                : item
                            )
                          )
                        }
                      />
                      <input
                        className="rounded-md border border-[var(--divider)] bg-[var(--surface)] px-3 py-2 text-sm"
                        placeholder="email"
                        value={participant.email ?? ""}
                        onChange={(event) =>
                          setParticipants((current) =>
                            current.map((item) =>
                              item.id === participant.id
                                ? { ...item, email: event.target.value }
                                : item
                            )
                          )
                        }
                      />
                      <input
                        className="rounded-md border border-[var(--divider)] bg-[var(--surface)] px-3 py-2 text-sm"
                        placeholder="Speaker"
                        value={participant.speakerLabel ?? ""}
                        onChange={(event) =>
                          setParticipants((current) =>
                            current.map((item) =>
                              item.id === participant.id
                                ? { ...item, speakerLabel: event.target.value }
                                : item
                            )
                          )
                        }
                      />
                      <Button
                        variant="outline"
                        onClick={() => saveParticipant(participant)}
                      >
                        Save
                      </Button>
                    </div>
                  )) : (
                    <div className="rounded-md border border-dashed border-[var(--divider)] p-4 text-sm text-muted-foreground">
                      No participants were found for this meeting yet.
                    </div>
                  )}
                </div>
              </section>
            </div>
          ) : null}
          {tagsOpen ? (
            <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4">
              <section className="w-full max-w-md rounded-lg border border-[var(--divider)] bg-[var(--surface)] p-5 shadow-xl">
                <h2 className="text-lg font-semibold">Edit tags</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Separate tags with commas.
                </p>
                <textarea
                  className="mt-4 min-h-28 w-full rounded-md border border-[var(--divider)] bg-[var(--surface)] p-3 text-sm"
                  value={tagDraft}
                  onChange={(event) => setTagDraft(event.target.value)}
                />
                <div className="mt-4 flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setTagsOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={saveTags}>Save tags</Button>
                </div>
              </section>
            </div>
          ) : null}
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
                  onSyncMeetArtifacts={syncMeetArtifacts}
                  onRetryJob={retryJob}
                />
              )}
        </section>
      </div>
    </main>
  )
}
