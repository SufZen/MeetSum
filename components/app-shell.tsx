"use client"

import {
  type ChangeEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react"
import { useRouter } from "next/navigation"
import {
  BotIcon,
  CalendarIcon,
  DatabaseIcon,
  GitBranchIcon,
  MailIcon,
  SearchIcon,
  SendIcon,
  SparklesIcon,
  UploadIcon,
} from "lucide-react"

import { LanguageSwitcher } from "@/components/language-switcher"
import { MeetingDetail } from "@/components/meeting-detail"
import { MeetingIntelligencePanel } from "@/components/meeting-intelligence-panel"
import { MeetingList } from "@/components/meeting-list"
import { MeetingRecorder } from "@/components/meeting-recorder"
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

const navIcons = [CalendarIcon, BotIcon, MailIcon, GitBranchIcon, DatabaseIcon]
const panelKeys = ["meetings", "memory", "workspace", "automations", "storage"] as const

export function AppShell({
  dictionary,
  locale,
  meetings,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
  meetings: MeetingRecord[]
}) {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [meetingRecords, setMeetingRecords] = useState(meetings)
  const [selectedMeetingId, setSelectedMeetingId] = useState(
    meetings[0]?.id ?? ""
  )
  const [query, setQuery] = useState("")
  const [activePanel, setActivePanel] =
    useState<(typeof panelKeys)[number]>("meetings")
  const [askQuestion, setAskQuestion] = useState(dictionary.askDefaultQuestion)
  const [askAnswer, setAskAnswer] = useState("")
  const [activeJob, setActiveJob] = useState<JobRecord | null>(null)
  const [exporting, setExporting] = useState(false)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    const meetingId = new URLSearchParams(window.location.search).get("meeting")

    if (meetingId && meetings.some((meeting) => meeting.id === meetingId)) {
      queueMicrotask(() => setSelectedMeetingId(meetingId))
    }
  }, [meetings])

  const filteredMeetings = useMemo(() => {
    const normalized = query.trim().toLowerCase()

    if (!normalized) return meetingRecords

    return meetingRecords.filter((meeting) =>
      [
        meeting.title,
        meeting.summary?.overview,
        ...(meeting.tags ?? []),
        ...(meeting.transcript?.map((segment) => segment.text) ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalized)
    )
  }, [meetingRecords, query])
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

  function selectMeeting(meetingId: string) {
    setSelectedMeetingId(meetingId)
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
      current.map((meeting) =>
        meeting.id === meetingId ? body.meeting : meeting
      )
    )
  }

  async function createMeetingForFile(file: File) {
    const response = await fetch("/api/meetings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: file.name.replace(/\.[^.]+$/, "") || "Uploaded meeting",
        source: "upload",
        language: "he",
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

    setActiveJob(body.job)
    await refreshMeeting(targetMeeting.id)
  }

  function handleUploadClick() {
    fileInputRef.current?.click()
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]

    if (!file) return
    startTransition(() => void uploadFile(file).catch((error) => setAskAnswer(error.message)))
    event.target.value = ""
  }

  function handleRecordingReady(file: File) {
    startTransition(
      () =>
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

      setActiveJob(body.job)
      await refreshMeeting(selectedMeeting.id)
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

      setActiveJob(body.job)
      await refreshMeeting(selectedMeeting.id)
    } finally {
      setExporting(false)
    }
  }

  function syncGoogle(source: "calendar" | "gmail" | "drive") {
    startTransition(() => {
      void (async () => {
      const response = await fetch(`/api/google/sync/${source}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: "info@realization.co.il" }),
      })
      const body = await response.json()

      if (!response.ok) {
        setAskAnswer(body.error ?? `Unable to sync ${source}`)
        return
      }

      setActiveJob(body.job)
      })()
    })
  }

  return (
    <main className="min-h-svh bg-background">
      <div className="grid min-h-svh grid-cols-1 lg:grid-cols-[272px_minmax(0,1fr)]">
        <aside className="border-b bg-sidebar p-4 lg:border-r lg:border-b-0">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <SparklesIcon aria-hidden="true" className="size-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold">MeetSum</h1>
              <p className="truncate text-sm text-muted-foreground">
                {dictionary.appSubtitle}
              </p>
            </div>
          </div>

          <Separator className="my-4" />

          <nav className="grid gap-1 text-sm">
            {navItems.map((label, index) => {
              const Icon = navIcons[index]

              return (
                <Button
                  key={label}
                  variant={activePanel === panelKeys[index] ? "secondary" : "ghost"}
                  className="h-10 justify-start rounded-md"
                  onClick={() => setActivePanel(panelKeys[index])}
                >
                  <Icon data-icon="inline-start" />
                  {label}
                </Button>
              )
            })}
          </nav>

          <Separator className="my-4" />

          <div className="grid gap-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">
                {dictionary.workspaceSync}
              </span>
              <Badge variant="secondary" className="rounded-sm">
                {dictionary.queued}
              </Badge>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button type="button" onClick={() => syncGoogle("calendar")}>
                <Badge
                  variant="outline"
                  className="w-full justify-center rounded-sm"
                >
                  Calendar
                </Badge>
              </button>
              <button type="button" onClick={() => syncGoogle("gmail")}>
                <Badge
                  variant="outline"
                  className="w-full justify-center rounded-sm"
                >
                  Gmail
                </Badge>
              </button>
              <button type="button" onClick={() => syncGoogle("drive")}>
                <Badge
                  variant="outline"
                  className="w-full justify-center rounded-sm"
                >
                  Drive
                </Badge>
              </button>
            </div>
            {activeJob && (
              <p className="text-xs text-muted-foreground">
                {activeJob.name}: {activeJob.status}
              </p>
            )}
          </div>
        </aside>

        <section className="flex min-w-0 flex-col">
          <header className="border-b bg-background/95 p-4">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <div className="min-w-0">
                <p className="text-sm text-muted-foreground">
                  {dictionary.controlPlane} · {activePanel}
                </p>
                <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
                  {dictionary.pageTitle}
                </h2>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <LanguageSwitcher locale={locale} />
                <MeetingRecorder
                  onRecordingReady={handleRecordingReady}
                  labels={{
                    ready: dictionary.recorderReady,
                    record: dictionary.record,
                    stop: dictionary.stop,
                    recording: dictionary.recording,
                    blocked: dictionary.recorderBlocked,
                    unsupported: dictionary.recorderUnsupported,
                  }}
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept="audio/*,video/*"
                  onChange={handleFileChange}
                />
                <Button
                  variant="outline"
                  className="h-9"
                  disabled={isPending}
                  onClick={handleUploadClick}
                >
                  <UploadIcon data-icon="inline-start" />
                  {dictionary.upload}
                </Button>
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

          <div className="grid flex-1 grid-cols-1 xl:grid-cols-[minmax(300px,400px)_minmax(0,1fr)] 2xl:grid-cols-[minmax(300px,400px)_minmax(0,1fr)_340px]">
            <div className="border-b p-4 xl:border-r xl:border-b-0">
              <div className="mb-4 flex h-10 items-center gap-2 rounded-md border bg-card px-3">
                <SearchIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={dictionary.commandPlaceholder}
                  className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                />
              </div>
              <MeetingList
                meetings={filteredMeetings}
                locale={locale}
                selectedMeetingId={selectedMeeting?.id}
                onSelectMeeting={selectMeeting}
              />
            </div>

            <div className="min-w-0 border-b p-4 xl:border-r xl:border-b-0">
              <MeetingDetail
                dictionary={dictionary}
                meeting={selectedMeeting}
                askQuestion={askQuestion}
                askAnswer={askAnswer}
                asking={isPending}
                onAskQuestionChange={setAskQuestion}
                onAsk={askMeeting}
                onToggleActionItem={toggleActionItem}
              />
            </div>

            <aside className="p-4 xl:col-span-2 xl:border-t 2xl:col-span-1 2xl:border-t-0">
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
