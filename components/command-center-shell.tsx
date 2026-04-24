"use client"

import { type ChangeEvent, useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { SearchIcon } from "lucide-react"

import { JobActivityCenter } from "@/components/job-activity-center"
import { MainSidebar, type MainPanelKey } from "@/components/main-sidebar"
import { MeetingInboxPanel } from "@/components/meeting-inbox-panel"
import { MeetingRightRail } from "@/components/meeting-right-rail"
import { MeetingWorkspace } from "@/components/meeting-workspace"
import {
  ProviderHealthPanel,
  type ProviderStatusView,
} from "@/components/provider-health-panel"
import { TopCommandBar, type SyncTarget } from "@/components/top-command-bar"
import {
  WorkspaceSyncPanel,
  type WorkspaceStatusView,
} from "@/components/workspace-sync-panel"
import { Input } from "@/components/ui/input"
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
    .filter((meeting) =>
      statusFilter === "all" ? true : meeting.status === statusFilter
    )
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
  const [meetingRecords, setMeetingRecords] = useState(meetings)
  const [selectedMeetingId, setSelectedMeetingId] = useState(meetings[0]?.id ?? "")
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [activePanel, setActivePanel] = useState<MainPanelKey>("meetings")
  const [askQuestion, setAskQuestion] = useState(dictionary.askDefaultQuestion)
  const [askAnswer, setAskAnswer] = useState("")
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [providers, setProviders] = useState<ProviderStatusView[]>([])
  const [workspaceStatus, setWorkspaceStatus] = useState<WorkspaceStatusView>()
  const [exporting, setExporting] = useState(false)
  const [syncing, setSyncing] = useState(false)
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

  const filteredMeetings = useMemo(
    () => filterMeetings(meetingRecords, query, statusFilter),
    [meetingRecords, query, statusFilter]
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
    await refreshMeeting(targetMeeting.id)
    await refreshOperationalState()
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]

    if (!file) return
    startTransition(() =>
      void uploadFile(file).catch((error) => setAskAnswer(error.message))
    )
    event.target.value = ""
  }

  function handleRecordingReady(file: File) {
    startTransition(() =>
      void uploadFile(file, selectedMeeting ?? undefined).catch((error) =>
        setAskAnswer(error.message)
      )
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
      await refreshMeeting(selectedMeeting.id)
      await refreshOperationalState()
    } finally {
      setExporting(false)
    }
  }

  function syncGoogle(target: SyncTarget) {
    setSyncing(true)
    startTransition(() => {
      void (async () => {
        try {
          const endpoint =
            target === "all" ? "/api/google/sync/all" : `/api/google/sync/${target}`
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ subject: "info@realization.co.il" }),
          })
          const body = await response.json()

          if (!response.ok) {
            setAskAnswer(body.error ?? "Unable to sync Google Workspace")
            return
          }

          setJobs((current) => [
            ...("jobs" in body ? body.jobs : [body.job]).filter(Boolean),
            ...current,
          ])
          await refreshOperationalState()
        } finally {
          setSyncing(false)
        }
      })()
    })
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

  function renderWorkspacePanel() {
    return (
      <div className="grid gap-4 bg-slate-50 p-5 lg:grid-cols-2">
        <WorkspaceSyncPanel
          status={workspaceStatus}
          syncing={syncing}
          onSyncAll={() => syncGoogle("all")}
        />
        <ProviderHealthPanel providers={providers} />
        <div className="lg:col-span-2">
          <JobActivityCenter jobs={jobs} onRetry={retryJob} />
        </div>
      </div>
    )
  }

  function renderSecondaryPanel() {
    return (
      <div className="grid gap-4 bg-slate-50 p-5 lg:grid-cols-2">
        <section className="rounded-md border bg-white p-4">
          <div className="mb-3 flex items-center gap-2">
            <SearchIcon aria-hidden="true" className="size-4 text-teal-700" />
            <h2 className="text-sm font-semibold">
              {activePanel === "memory" ? "Cross-meeting memory" : activePanel}
            </h2>
          </div>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search summaries, transcripts, tags, and decisions"
            className="h-10"
          />
        </section>
        <JobActivityCenter jobs={jobs} onRetry={retryJob} />
      </div>
    )
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
        onQueryChange={setQuery}
        onFilterChange={setStatusFilter}
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
    <main className="min-h-svh bg-slate-50 text-slate-950">
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
            onQueryChange={setQuery}
            onFileChange={handleFileChange}
            onRecordingReady={handleRecordingReady}
            onSync={syncGoogle}
          />
          {activePanel === "meetings"
            ? defaultMeetingsView
            : activePanel === "workspace" || activePanel === "settings"
              ? renderWorkspacePanel()
              : renderSecondaryPanel()}
        </section>
      </div>
    </main>
  )
}
