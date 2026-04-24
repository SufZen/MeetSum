"use client"

import { type ChangeEvent, useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  BotIcon,
  CalendarIcon,
  DatabaseIcon,
  GitBranchIcon,
  LayoutDashboardIcon,
  MailIcon,
  RefreshCwIcon,
  SearchIcon,
  SendIcon,
  SparklesIcon,
} from "lucide-react"

import { JobActivityCenter } from "@/components/job-activity-center"
import { LanguageSwitcher } from "@/components/language-switcher"
import { MediaIngestionDrawer } from "@/components/media-ingestion-drawer"
import { MeetingInboxPanel } from "@/components/meeting-inbox-panel"
import { MeetingIntelligencePanel } from "@/components/meeting-intelligence-panel"
import { MeetingWorkspace } from "@/components/meeting-workspace"
import {
  ProviderHealthPanel,
  type ProviderStatusView,
} from "@/components/provider-health-panel"
import {
  WorkspaceSyncPanel,
  type WorkspaceStatusView,
} from "@/components/workspace-sync-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"
import type {
  ActionItem,
  JobRecord,
  MeetingRecord,
} from "@/lib/meetings/repository"

const panelKeys = [
  "meetings",
  "memory",
  "workspace",
  "automations",
  "storage",
] as const

const navIcons = [CalendarIcon, BotIcon, MailIcon, GitBranchIcon, DatabaseIcon]

type PanelKey = (typeof panelKeys)[number]

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
  const [activePanel, setActivePanel] = useState<PanelKey>("meetings")
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

  async function refreshProvidersAndWorkspace() {
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
      void refreshProvidersAndWorkspace()
    }, 0)
    const intervalId = window.setInterval(() => {
      void refreshProvidersAndWorkspace()
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
  const totalActionItems = meetingRecords.reduce(
    (count, meeting) => count + (meeting.summary?.actionItems.length ?? 0),
    0
  )
  const navItems = [
    dictionary.navMeetings,
    dictionary.navMemory,
    dictionary.navWorkspace,
    dictionary.navAutomations,
    dictionary.navStorage,
  ]
  const providerFailures = providers.filter((provider) => !provider.configured).length

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
    await refreshProvidersAndWorkspace()
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

  function runIntelligence() {
    if (!selectedMeeting) return

    startTransition(() => {
      void (async () => {
        const response = await fetch(
          `/api/meetings/${selectedMeeting.id}/intelligence/run`,
          { method: "POST" }
        )
        const body = await response.json()

        if (!response.ok) {
          setAskAnswer(body.error ?? "Unable to run intelligence")
          return
        }

        setJobs((current) => [body.job, ...current])
        await refreshMeeting(selectedMeeting.id)
        await refreshProvidersAndWorkspace()
      })()
    })
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
      await refreshProvidersAndWorkspace()
    } finally {
      setExporting(false)
    }
  }

  function syncAllGoogle() {
    setSyncing(true)
    startTransition(() => {
      void (async () => {
        try {
          const response = await fetch("/api/google/sync/all", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ subject: "info@realization.co.il" }),
          })
          const body = await response.json()

          if (!response.ok) {
            setAskAnswer(body.error ?? "Unable to sync Google Workspace")
            return
          }

          setJobs((current) => [...body.jobs, ...current])
          await refreshProvidersAndWorkspace()
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

  function renderMainPanel() {
    if (activePanel === "workspace") {
      return (
        <div className="grid gap-4 lg:grid-cols-2">
          <WorkspaceSyncPanel
            status={workspaceStatus}
            syncing={syncing}
            onSyncAll={syncAllGoogle}
          />
          <ProviderHealthPanel providers={providers} />
          <div className="lg:col-span-2">
            <JobActivityCenter jobs={jobs} onRetry={retryJob} />
          </div>
        </div>
      )
    }

    if (activePanel === "memory") {
      return (
        <div className="grid gap-4">
          <section className="rounded-md border bg-card p-4">
            <div className="mb-3 flex items-center gap-2">
              <SearchIcon aria-hidden="true" className="size-4 text-primary" />
              <h2 className="text-sm font-semibold">Cross-meeting memory</h2>
            </div>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search summaries, transcripts, tags, and decisions"
              className="h-10"
            />
          </section>
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
        </div>
      )
    }

    if (activePanel === "automations" || activePanel === "storage") {
      return (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-md border bg-card p-4">
            <h2 className="mb-2 text-sm font-semibold">
              {activePanel === "automations"
                ? dictionary.navAutomations
                : dictionary.navStorage}
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">
              Infrastructure is wired now: jobs, webhooks, RealizeOS exports,
              retention policy, and object storage health are visible while live
              workflow execution stays intentionally deferred.
            </p>
          </section>
          <JobActivityCenter jobs={jobs} onRetry={retryJob} />
        </div>
      )
    }

    return (
      <MeetingWorkspace
        dictionary={dictionary}
        meeting={selectedMeeting}
        question={askQuestion}
        answer={askAnswer}
        asking={isPending}
        onQuestionChange={setAskQuestion}
        onAsk={askMeeting}
        onToggleActionItem={toggleActionItem}
      />
    )
  }

  return (
    <main className="min-h-svh bg-[oklch(0.975_0.008_88)] text-foreground">
      <div className="grid min-h-svh grid-cols-1 xl:grid-cols-[264px_minmax(0,1fr)]">
        <aside className="bg-[oklch(0.18_0.018_240)] p-4 text-white xl:min-h-svh">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <SparklesIcon aria-hidden="true" className="size-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold">MeetSum</h1>
              <p className="truncate text-sm text-white/62">
                {dictionary.appSubtitle}
              </p>
            </div>
          </div>

          <Separator className="my-4 bg-white/10" />

          <nav className="grid gap-1 text-sm">
            {navItems.map((label, index) => {
              const Icon = navIcons[index]
              const selected = activePanel === panelKeys[index]

              return (
                <Button
                  key={label}
                  variant="ghost"
                  className={
                    selected
                      ? "h-10 justify-start rounded-md bg-white/12 text-white hover:bg-white/14 hover:text-white"
                      : "h-10 justify-start rounded-md text-white/72 hover:bg-white/10 hover:text-white"
                  }
                  onClick={() => setActivePanel(panelKeys[index])}
                >
                  <Icon data-icon="inline-start" />
                  {label}
                </Button>
              )
            })}
          </nav>

          <Separator className="my-4 bg-white/10" />

          <div className="grid gap-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-white/62">{dictionary.workspaceSync}</span>
              <Badge
                variant="outline"
                className="rounded-sm border-white/20 text-white"
              >
                {workspaceStatus?.jobs.active ?? 0} active
              </Badge>
            </div>
            <Button
              variant="ghost"
              className="h-9 justify-start rounded-md bg-white/8 text-white hover:bg-white/12 hover:text-white"
              disabled={syncing}
              onClick={syncAllGoogle}
            >
              <RefreshCwIcon data-icon="inline-start" />
              {syncing ? "Syncing..." : "Sync all"}
            </Button>
            <div className="grid grid-cols-3 gap-2 text-xs text-white/72">
              <div className="rounded-md border border-white/10 p-2">
                <div className="font-mono text-white">
                  {workspaceStatus?.jobs.queued ?? 0}
                </div>
                queued
              </div>
              <div className="rounded-md border border-white/10 p-2">
                <div className="font-mono text-white">
                  {workspaceStatus?.jobs.failed ?? 0}
                </div>
                failed
              </div>
              <div className="rounded-md border border-white/10 p-2">
                <div className="font-mono text-white">{providerFailures}</div>
                missing
              </div>
            </div>
          </div>
        </aside>

        <section className="flex min-w-0 flex-col">
          <header className="border-b bg-background/95 p-4">
            <div className="flex flex-col gap-4 2xl:flex-row 2xl:items-center 2xl:justify-between">
              <div className="min-w-0">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="rounded-sm">
                    <LayoutDashboardIcon data-icon="inline-start" className="size-3" />
                    {dictionary.controlPlane}
                  </Badge>
                  <Badge variant="secondary" className="rounded-sm">
                    {activePanel}
                  </Badge>
                </div>
                <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
                  {dictionary.pageTitle}
                </h2>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex h-9 min-w-60 items-center gap-2 rounded-md border bg-card px-3">
                  <SearchIcon
                    aria-hidden="true"
                    className="size-4 text-muted-foreground"
                  />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={dictionary.commandPlaceholder}
                    className="h-7 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                  />
                </div>
                <LanguageSwitcher locale={locale} />
                <MediaIngestionDrawer
                  dictionary={dictionary}
                  pending={isPending}
                  onFileChange={handleFileChange}
                  onRecordingReady={handleRecordingReady}
                />
                <Button
                  className="h-9"
                  disabled={!selectedMeeting || isPending}
                  onClick={runIntelligence}
                >
                  <SendIcon data-icon="inline-start" />
                  {dictionary.runAgent}
                </Button>
              </div>
            </div>
          </header>

          <div className="grid flex-1 grid-cols-1 gap-0 xl:grid-cols-[minmax(280px,360px)_minmax(0,1fr)_340px] 2xl:grid-cols-[minmax(300px,388px)_minmax(0,1fr)_352px]">
            <div className="min-h-0 border-b p-4 xl:border-r xl:border-b-0">
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
            </div>

            <div className="min-w-0 border-b p-4 xl:border-r xl:border-b-0">
              {renderMainPanel()}
            </div>

            <aside className="grid content-start gap-4 p-4 xl:col-span-1 xl:border-t-0">
              <ProviderHealthPanel providers={providers} />
              <WorkspaceSyncPanel
                status={workspaceStatus}
                syncing={syncing}
                onSyncAll={syncAllGoogle}
              />
              <JobActivityCenter jobs={jobs.slice(0, 5)} onRetry={retryJob} />
              <MeetingIntelligencePanel
                dictionary={dictionary}
                meeting={selectedMeeting}
                totalActionItems={totalActionItems}
                onToggleActionItem={toggleActionItem}
                onExportRealizeOS={exportRealizeOS}
                exporting={exporting}
              />
            </aside>
          </div>
        </section>
      </div>
    </main>
  )
}
