"use client"

import {
  type CSSProperties,
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react"
import dynamic from "next/dynamic"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { botApi } from "@/components/bot/bot-api"
import {
  BotSessionsProvider,
  type BotSessionsContextValue,
} from "@/components/bot/bot-sessions-context"
import { RecorderDock } from "@/components/bot/recorder-dock"
import { dockEntriesFrom, type DockStopAction } from "@/components/bot/recorder-dock-state"
import { StopBotDialog } from "@/components/bot/stop-bot-dialog"
import { useBotSessions } from "@/components/bot/use-bot-sessions"
import { useBrowserRecorder } from "@/components/bot/use-browser-recorder"
import { CommandPaletteHost } from "@/components/command-palette"
import { useWorkspace } from "@/components/workspace-context"
import {
  DriveRecordingPickerDrawer,
  type DriveImportResult,
} from "@/components/drive-recording-picker-drawer"
import {
  MainSidebar,
  type MainPanelKey,
  type SidebarRoom,
  type SidebarUser,
} from "@/components/main-sidebar"
import {
  MeetingInboxPanel,
  type MeetingSortMode,
} from "@/components/meeting-inbox-panel"
import { MeetingRightRail } from "@/components/meeting-right-rail"
import { MeetingWorkspace, type MeetingPermissions } from "@/components/meeting-workspace"
import { localizeSpeakerLabel } from "@/components/speaker-display"
import { TalkTimePanel } from "@/components/talk-time-panel"
import { useMeetingTranscript } from "@/components/transcript/use-meeting-transcript"
import type { ProviderStatusView } from "@/components/provider-health-panel"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  TopCommandBar,
  type AiProviderStatus,
  type SyncTarget,
} from "@/components/top-command-bar"
import type { WorkspaceStatusView } from "@/components/workspace-sync-panel"
import {
  SLOW_STATUS_POLL_MS,
  nextPollDelay,
} from "@/lib/client/polling"
import { apiErrorMessage } from "@/lib/i18n/api-errors"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"
import { selectRecentRooms } from "@/lib/rooms"
import type {
  ActionItem,
  JobRecord,
  MeetingListItem,
  MeetingParticipant,
  MeetingRecord,
  MeetingVisibility,
  SuggestedAgentRun,
} from "@/lib/meetings/repository"
import type { MeetingDetailResponse } from "@/lib/meetings/transcript-wire"
import { parseTimeParam } from "@/lib/player/deep-link"

// M5 analytics card: its own chunk (right rail only).
const AnalyticsCard = dynamic(
  () => import("@/components/intelligence/analytics-card").then((mod) => mod.AnalyticsCard),
  { ssr: false }
)

// Secondary panels load on demand so the meetings view stays light.
const panelLoading = () => (
  <div aria-busy="true" className="min-h-[calc(100svh-3.5rem)] animate-pulse bg-surface-2" />
)
const AdminPanel = dynamic(
  () => import("@/components/admin/admin-panel").then((mod) => mod.AdminPanel),
  { loading: panelLoading }
)
// The join dialog (and A's link parser) load only when it first opens.
const JoinMeetingDialog = dynamic(
  () => import("@/components/bot/join-meeting-dialog").then((mod) => mod.JoinMeetingDialog),
  { ssr: false }
)
const OperationalPage = dynamic(
  () => import("@/components/operational-pages").then((mod) => mod.OperationalPage),
  { loading: panelLoading }
)

type MeetingPageState = {
  limit: number
  offset: number
  total: number
  hasMore: boolean
}

type DetailEntry = { meeting: MeetingRecord; permissions: MeetingPermissions }

const DETAIL_CACHE_SIZE = 10
const NO_PERMISSIONS: MeetingPermissions = { canWrite: false, canManage: false }
const IDLE_MEETING_STATUSES = new Set(["completed", "failed", "scheduled", "created"])

/** Inbox fields of a full record (keeps list-only counters it lacks). */
function listItemFromRecord(record: MeetingRecord, previous?: MeetingListItem): MeetingListItem {
  const {
    transcript,
    intelligence: _intelligence,
    aiRuns: _aiRuns,
    suggestedAgentRuns: _suggestedAgentRuns,
    meetConferenceRecords: _meetConferenceRecords,
    speakers: _speakers,
    summary,
    ...rest
  } = record

  void [_intelligence, _aiRuns, _suggestedAgentRuns, _meetConferenceRecords, _speakers]

  return {
    ...previous,
    ...rest,
    transcriptSegmentCount:
      record.transcriptSegmentCount ?? transcript?.length ?? previous?.transcriptSegmentCount ?? 0,
    actionItemCount: summary?.actionItems.length ?? previous?.actionItemCount ?? 0,
    hasMedia: (record.mediaAssets?.length ?? 0) > 0 || Boolean(previous?.hasMedia),
  }
}

function isActiveJob(job: JobRecord) {
  return job.status === "queued" || job.status === "active"
}

function hasImportableMeetArtifacts(meeting: MeetingRecord | null) {
  return Boolean(
    meeting?.meetConferenceRecords?.some((record) =>
      record.artifacts.some((artifact) =>
        ["transcript", "smart_notes", "recording"].includes(artifact.artifactType)
      )
    )
  )
}

export function CommandCenterShell({
  dictionary,
  locale,
  meetings,
  rooms,
  user,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
  meetings: MeetingListItem[]
  rooms: SidebarRoom[]
  user?: SidebarUser
}) {
  const router = useRouter()
  const [sidebarRooms, setSidebarRooms] = useState(rooms)
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
  const [detail, setDetail] = useState<DetailEntry | null>(null)
  const detailCacheRef = useRef(new Map<string, DetailEntry>())
  const detailAbortRef = useRef<AbortController | null>(null)
  const [deepLinkTime, setDeepLinkTime] = useState<{ meetingId: string; ms: number } | null>(null)
  const [shareSections, setShareSections] = useState<string[] | null>(null)
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [providers, setProviders] = useState<ProviderStatusView[]>([])
  const [workspaceStatus, setWorkspaceStatus] = useState<WorkspaceStatusView>()
  const [exporting, setExporting] = useState(false)
  const [suggestingAgents, setSuggestingAgents] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  // M7 meeting bot + recorder dock.
  const { activeWorkspace } = useWorkspace()
  const botSessions = useBotSessions(activeWorkspace?.id)
  const [joinOpen, setJoinOpen] = useState(false)
  const [joinDialogReady, setJoinDialogReady] = useState(false)
  const [desktopOpen, setDesktopOpen] = useState(false)
  const [stopTarget, setStopTarget] = useState<{ meetingId: string; title: string | null } | null>(
    null
  )
  const [stopBusy, setStopBusy] = useState(false)
  const [dockHeight, setDockHeight] = useState(0)
  const browserRecorder = useBrowserRecorder({
    onRecordingReady: (file, meta) => handleBrowserRecording(file, meta.meetingId),
  })
  const [drivePickerOpen, setDrivePickerOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [shareLink, setShareLink] = useState("")
  const [sharePrivateConfirm, setSharePrivateConfirm] = useState(false)
  const [participantsOpen, setParticipantsOpen] = useState(false)
  const [participants, setParticipants] = useState<MeetingParticipant[]>([])
  const [tagsOpen, setTagsOpen] = useState(false)
  const [tagDraft, setTagDraft] = useState("")
  const [payloadPreviewOpen, setPayloadPreviewOpen] = useState(false)
  const [payloadPreview, setPayloadPreview] = useState<string>("")
  const [darkMode, setDarkMode] = useState(false)
  const [isPending, startTransition] = useTransition()

  // A ?meeting= deep link (e.g. from a room page) may point outside the
  // current page of meetings; fetch it once and keep it pinned in the list
  // until the user selects a different meeting.
  const deepLinkedMeetingRef = useRef<MeetingListItem | null>(null)
  const deepLinkAttemptRef = useRef<string | null>(null)
  const deepLinkTimeReadRef = useRef(false)

  /** LRU of meeting details (most recent last). */
  const rememberDetail = useCallback((entry: DetailEntry) => {
    const cache = detailCacheRef.current

    cache.delete(entry.meeting.id)
    cache.set(entry.meeting.id, entry)
    while (cache.size > DETAIL_CACHE_SIZE) cache.delete(cache.keys().next().value as string)
    setDetail((current) =>
      !current || current.meeting.id === entry.meeting.id ? entry : current
    )
  }, [])

  // M8: `?panel=settings&section=integrations` deep link (OAuth return).
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("panel") === "settings") {
      queueMicrotask(() => setActivePanel("settings"))
    }
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const meetingId = params.get("meeting")

    if (!deepLinkTimeReadRef.current) {
      deepLinkTimeReadRef.current = true

      const ms = parseTimeParam(params.get("t"))

      if (meetingId && ms !== undefined) queueMicrotask(() => setDeepLinkTime({ meetingId, ms }))
    }

    if (!meetingId) return
    if (meetingRecords.some((meeting) => meeting.id === meetingId)) {
      queueMicrotask(() => setSelectedMeetingId(meetingId))
      return
    }
    if (deepLinkAttemptRef.current === meetingId) return

    deepLinkAttemptRef.current = meetingId
    void fetch(`/api/meetings/${encodeURIComponent(meetingId)}`)
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body: Partial<MeetingDetailResponse> | undefined) => {
        const record = body?.meeting

        if (!record) return

        const linked = listItemFromRecord(record)

        rememberDetail({ meeting: record, permissions: body?.permissions ?? NO_PERMISSIONS })
        deepLinkedMeetingRef.current = linked
        setMeetingRecords((current) =>
          current.some((meeting) => meeting.id === linked.id)
            ? current
            : [linked, ...current]
        )
        setSelectedMeetingId(linked.id)
      })
      .catch(() => undefined)
  }, [meetingRecords, rememberDetail])

  // Jobs drive the adaptive poll; completions refresh the list and detail.
  const jobsSeenRef = useRef(new Map<string, JobRecord["status"]>())
  const onJobsFinishedRef = useRef<(meetingIds: Set<string>) => void>(() => undefined)

  const refreshJobs = useCallback(async () => {
    const response = await fetch("/api/jobs").catch(() => undefined)

    if (!response?.ok) return

    const body = await response.json()
    const nextJobs: JobRecord[] = body.jobs ?? []
    const seen = jobsSeenRef.current
    const finished = new Set<string>()

    for (const job of nextJobs) {
      const before = seen.get(job.id)

      if (
        job.meetingId &&
        (before === "queued" || before === "active") &&
        (job.status === "completed" || job.status === "failed")
      ) {
        finished.add(job.meetingId)
      }
      seen.set(job.id, job.status)
    }

    setJobs(nextJobs)
    if (finished.size) onJobsFinishedRef.current(finished)
  }, [])

  const refreshStatus = useCallback(async () => {
    const [providersResponse, workspaceResponse] = await Promise.all([
      fetch("/api/ai/providers/status").catch(() => undefined),
      fetch("/api/workspace/status").catch(() => undefined),
    ])

    if (providersResponse?.ok) {
      const body = await providersResponse.json()
      setProviders(body.providers ?? [])
    }
    if (workspaceResponse?.ok) {
      const body = await workspaceResponse.json()
      setWorkspaceStatus(body.workspace)
    }
  }, [])

  async function refreshOperationalState() {
    await Promise.all([refreshJobs(), refreshStatus()])
  }

  // Providers and workspace status: on mount and every 5 minutes.
  useEffect(() => {
    const timeoutId = window.setTimeout(() => void refreshStatus(), 0)
    const intervalId = window.setInterval(() => void refreshStatus(), SLOW_STATUS_POLL_MS)

    return () => {
      window.clearTimeout(timeoutId)
      window.clearInterval(intervalId)
    }
  }, [refreshStatus])

  // Jobs: 5 s while anything processes, 60 s idle, paused while hidden.
  const pollInputsRef = useRef({ activeJobs: 0, selectedProcessing: false })
  const kickPollRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    let timeoutId: number | undefined
    let cancelled = false

    const schedule = () => {
      window.clearTimeout(timeoutId)
      if (cancelled) return

      const delay = nextPollDelay({
        ...pollInputsRef.current,
        hidden: document.visibilityState === "hidden",
      })

      if (delay === null) return
      timeoutId = window.setTimeout(() => {
        void refreshJobs().finally(schedule)
      }, delay)
    }
    const onVisibility = () => {
      window.clearTimeout(timeoutId)
      if (document.visibilityState === "visible") void refreshJobs().finally(schedule)
    }

    kickPollRef.current = () => {
      window.clearTimeout(timeoutId)
      schedule()
    }
    timeoutId = window.setTimeout(() => void refreshJobs().finally(schedule), 0)
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [refreshJobs])

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

  const geminiProvider = providers.find((provider) => provider.id === "gemini")
  const aiStatus: AiProviderStatus | undefined = geminiProvider
    ? {
        configured: geminiProvider.configured,
        label: geminiProvider.label,
        detail: geminiProvider.detail,
      }
    : undefined

  const selectedListItem =
    meetingRecords.find((meeting) => meeting.id === selectedMeetingId) ??
    meetingRecords[0] ??
    null
  // The full record comes from `/api/meetings/[id]`; until it arrives the
  // list row (a subset of the record) renders the header.
  const selectedDetail =
    detail && selectedListItem && detail.meeting.id === selectedListItem.id ? detail : null
  const selectedMeeting: MeetingRecord | null = selectedDetail?.meeting ?? selectedListItem
  const selectedPermissions = selectedDetail?.permissions ?? NO_PERMISSIONS
  const selectedId = selectedListItem?.id
  const transcript = useMeetingTranscript(selectedDetail ? selectedId : undefined, {
    version: selectedDetail?.meeting.transcriptVersion,
  })

  const loadDetail = useCallback(
    async (meetingId: string) => {
      detailAbortRef.current?.abort()

      const controller = new AbortController()

      detailAbortRef.current = controller

      try {
        const response = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}`, {
          signal: controller.signal,
        })
        const body = (await response.json().catch(() => ({}))) as Partial<MeetingDetailResponse> & {
          error?: string
        }

        if (!response.ok || !body.meeting) throw new Error(body.error ?? "Unable to refresh meeting")

        const entry: DetailEntry = { meeting: body.meeting, permissions: body.permissions ?? NO_PERMISSIONS }

        rememberDetail(entry)
        setMeetingRecords((current) =>
          current.map((meeting) =>
            meeting.id === meetingId ? listItemFromRecord(entry.meeting, meeting) : meeting
          )
        )

        return entry
      } catch (error) {
        if (controller.signal.aborted) return undefined
        throw error
      }
    },
    [rememberDetail]
  )

  // Selecting a meeting shows its cached detail at once and revalidates.
  useEffect(() => {
    if (!selectedId) return

    const cached = detailCacheRef.current.get(selectedId)

    queueMicrotask(() => {
      setDetail(cached ?? null)
      void loadDetail(selectedId).catch(() => undefined)
    })
  }, [loadDetail, selectedId])

  // Keep the adaptive poll's inputs current; wake it when work starts.
  const activeJobCount = jobs.filter(isActiveJob).length
  const selectedProcessing = Boolean(
    selectedMeeting && !IDLE_MEETING_STATUSES.has(selectedMeeting.status)
  )

  useEffect(() => {
    const wasBusy = pollInputsRef.current.activeJobs > 0 || pollInputsRef.current.selectedProcessing

    pollInputsRef.current = { activeJobs: activeJobCount, selectedProcessing }
    if (!wasBusy && (activeJobCount > 0 || selectedProcessing)) kickPollRef.current()
  }, [activeJobCount, selectedProcessing])

  const selectMeeting = useCallback((meetingId: string) => {
    if (deepLinkedMeetingRef.current?.id !== meetingId) {
      deepLinkedMeetingRef.current = null
    }
    setSelectedMeetingId(meetingId)
    setActivePanel("meetings")
    const params = new URLSearchParams(window.location.search)

    params.set("meeting", meetingId)
    params.delete("t")
    router.replace(`?${params.toString()}`, { scroll: false })
  }, [router])

  async function refreshMeeting(meetingId = selectedMeeting?.id) {
    if (!meetingId) return

    detailCacheRef.current.delete(meetingId)
    if (meetingId === selectedId) {
      await loadDetail(meetingId)
      return
    }

    const response = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}`)
    const body = await response.json()

    if (!response.ok) {
      throw new Error(body.error ?? "Unable to refresh meeting")
    }

    setMeetingRecords((current) =>
      current.map((meeting) =>
        meeting.id === meetingId ? listItemFromRecord(body.meeting, meeting) : meeting
      )
    )
  }

  /** A full record came back from a mutation (favorite, tags, rename). */
  function upsertMeetingRecord(record: MeetingRecord) {
    const cached = detailCacheRef.current.get(record.id)

    if (cached) rememberDetail({ ...cached, meeting: { ...cached.meeting, ...record } })
    setMeetingRecords((current) =>
      current.map((meeting) => (meeting.id === record.id ? listItemFromRecord(record, meeting) : meeting))
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
    const listItems: MeetingListItem[] = meetingsBody.meetings ?? []
    const nextMeetings = listItems
    const pinned = deepLinkedMeetingRef.current
    const keepPinned = Boolean(
      pinned && !nextMeetings.some((meeting) => meeting.id === pinned.id)
    )

    setMeetingRecords((current) =>
      keepPinned && pinned
        ? [current.find((meeting) => meeting.id === pinned.id) ?? pinned, ...nextMeetings]
        : nextMeetings
    )
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
      !(keepPinned && pinned?.id === selectedMeetingId) &&
      !nextMeetings.some((meeting) => meeting.id === selectedMeetingId)
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

  // Job completed/failed for meeting X: refresh the list; if X is selected,
  // refetch its detail and transcript (the ETag makes an unchanged one a 304).
  useEffect(() => {
    onJobsFinishedRef.current = (meetingIds) => {
      void refreshMeetings()
      if (selectedId && meetingIds.has(selectedId)) {
        detailCacheRef.current.delete(selectedId)
        void loadDetail(selectedId).catch(() => undefined)
        transcript.refetch()
      }
    }
  })

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

    setMeetingRecords((current) =>
      [listItemFromRecord(body.meeting as MeetingRecord), ...current].slice(0, pageSize)
    )
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

  async function importDesktopFile(file: File) {
    const formData = new FormData()

    // Text fields go before the file: the server streams the file part to
    // storage and resolves where to put it from the fields received so far.
    formData.append(
      "meeting",
      JSON.stringify({
        title: file.name.replace(/\.[^.]+$/, "") || "Desktop recording",
        startedAt: new Date().toISOString(),
        language: "mixed",
        participants: [],
      })
    )
    formData.append(
      "captureMetadata",
      JSON.stringify({
        appVersion: "manual-import",
        platform: "unknown",
        uploadStatus: "uploaded",
      })
    )
    formData.append("file", file)

    const response = await fetch("/api/desktop-capture/ingest", {
      method: "POST",
      body: formData,
    })
    const body = await response.json()

    if (!response.ok) {
      throw new Error(body.error ?? "Unable to import desktop recording")
    }

    if (body.meeting) {
      setMeetingRecords((current) =>
        [listItemFromRecord(body.meeting as MeetingRecord), ...current].slice(0, pageSize)
      )
      setSelectedMeetingId(body.meeting.id)
      setActivePanel("meetings")
    }
    setJobs((current) => (body.job ? [body.job, ...current] : current))
    toast.success("Desktop recording queued for meeting intelligence")
    await refreshOperationalState()
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]

    if (!file) return
    toast.info(`Uploading ${file.name}`)
    startTransition(() =>
      void uploadFile(file).catch((error) => {
        toast.error(error.message)
      })
    )
    event.target.value = ""
  }

  function handleDesktopFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]

    if (!file) return
    toast.info(`Importing desktop recording ${file.name}`)
    startTransition(() =>
      void importDesktopFile(file).catch((error) => {
        toast.error(error.message)
      })
    )
    event.target.value = ""
  }

  function handleBrowserRecording(file: File, meetingId: string | null) {
    const target =
      (meetingId ? meetingRecords.find((meeting) => meeting.id === meetingId) : undefined) ??
      selectedMeeting ??
      undefined

    toast.info("Recording saved. Uploading audio...")
    startTransition(() =>
      void uploadFile(file, target).catch((error) => {
        toast.error(error.message)
      })
    )
  }

  function handleRecordingReady(file: File) {
    toast.info("Recording saved. Uploading audio...")
    startTransition(() =>
      void uploadFile(file, selectedMeeting ?? undefined).catch((error) => {
        toast.error(error.message)
      })
    )
  }

  async function toggleActionItem(item: ActionItem) {
    const response = await fetch(`/api/action-items/${item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        meetingId: selectedMeeting?.id,
        status: item.status === "done" ? "open" : "done",
      }),
    })
    const body = await response.json()

    if (!response.ok) {
      toast.error(body.error ?? "Unable to update action item")
      return
    }

    await refreshMeeting()
  }

  async function previewRealizeOSPayload() {
    if (!selectedMeeting) return

    setPayloadPreview("Loading…")
    setPayloadPreviewOpen(true)
    try {
      const response = await fetch(`/api/integrations/realizeos/preview/${selectedMeeting.id}`)
      const body = await response.json()

      if (!response.ok) {
        setPayloadPreview(JSON.stringify({ error: body.error ?? "Unable to build preview" }, null, 2))
        return
      }

      setPayloadPreview(JSON.stringify(body, null, 2))
    } catch {
      setPayloadPreview(JSON.stringify({ error: "Failed to fetch preview" }, null, 2))
    }
  }

  async function exportRealizeOS() {
    if (!selectedMeeting) return

    setPayloadPreviewOpen(false)
    setExporting(true)
    try {
      const response = await fetch("/api/integrations/realizeos/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ meetingId: selectedMeeting.id }),
      })
      const body = await response.json()

      if (!response.ok) {
        toast.error(body.error ?? "Unable to export to RealizeOS")
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

  async function suggestAgents() {
    if (!selectedMeeting) return

    setSuggestingAgents(true)
    try {
      const response = await fetch(
        `/api/meetings/${selectedMeeting.id}/agents/suggest`,
        { method: "POST" }
      )
      const body = await response.json()

      if (!response.ok) {
        toast.error(body.error ?? "Unable to suggest agents")
        return
      }

      await refreshMeeting(selectedMeeting.id)
      const count = body.suggestions?.length ?? 0

      toast.success(
        count
          ? `${count} agent suggestion${count === 1 ? "" : "s"} prepared`
          : "No new agent suggestions needed"
      )
    } finally {
      setSuggestingAgents(false)
    }
  }

  async function approveAgentRun(run: SuggestedAgentRun) {
    const response = await fetch(`/api/agent-runs/${run.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ meetingId: run.meetingId }),
    })
    const body = await response.json()

    if (!response.ok) {
      toast.error(body.error ?? "Unable to approve agent")
      return
    }

    if (body.job) {
      setJobs((current) => [body.job, ...current])
    }
    await refreshMeeting(run.meetingId)
    await refreshOperationalState()
    toast.success(
      body.job
        ? "Agent approved and queued"
        : "Agent approved. Execution connector is prepared."
    )
  }

  async function copyText(text: string, label: string) {
    if (!text.trim()) {
      toast.info(`${label} is empty`)
      return
    }

    await navigator.clipboard.writeText(text)
    toast.success(`${label} copied`)
  }

  function setMeetingVisibility(meetingId: string, visibility: MeetingVisibility) {
    setMeetingRecords((current) =>
      current.map((meeting) =>
        meeting.id === meetingId ? { ...meeting, visibility } : meeting
      )
    )
  }

  async function createShareLink() {
    if (!selectedMeeting) return

    setSharePrivateConfirm(false)
    const meetingId = selectedMeeting.id
    const response = await fetch(`/api/meetings/${meetingId}/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    const body = await response.json()

    if (!response.ok) {
      toast.error(
        body.reason === "meeting_manage_required"
          ? dictionary.visibilityReadOnly
          : (body.error ?? "Unable to create share link")
      )
      return
    }

    setShareLink(body.url)
    setShareSections(Array.isArray(body.share?.includedSections) ? body.share.includedSections : null)
    setMeetingVisibility(meetingId, "link")
  }

  /** "Include recording" adds or removes the opt-in `media` share section. */
  async function setShareIncludesRecording(include: boolean) {
    if (!selectedMeeting || !shareSections) return

    const next = include
      ? [...shareSections.filter((section) => section !== "media"), "media"]
      : shareSections.filter((section) => section !== "media")
    const response = await fetch(`/api/meetings/${selectedMeeting.id}/share`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includedSections: next }),
    })
    const body = await response.json().catch(() => ({}))

    if (!response.ok) {
      toast.error(body.error ?? "Unable to update share link")
      return
    }

    setShareSections(Array.isArray(body.share?.includedSections) ? body.share.includedSections : next)
  }

  async function openShareDialog() {
    if (!selectedMeeting) return

    setShareLink("")
    setShareSections(null)
    setShareOpen(true)

    // A public link widens a private meeting to the workspace: confirm first.
    if (selectedMeeting.visibility === "private") {
      setSharePrivateConfirm(true)
      return
    }

    await createShareLink()
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

    upsertMeetingRecord(body.meeting)
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

  async function handleSpeakersChanged() {
    // Speaker mapping or a transcript edit changed speaker rows/stats; reload
    // the detail (talk time, counts, version).
    await refreshMeeting(selectedMeeting?.id).catch(() => undefined)
  }

  async function renameMeeting(title: string): Promise<boolean> {
    if (!selectedMeeting) return false

    const response = await fetch(`/api/meetings/${encodeURIComponent(selectedMeeting.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }).catch(() => undefined)
    const body = await response?.json().catch(() => ({}))

    if (!response?.ok) {
      toast.error(dictionary.meetingRenameFailed)
      return false
    }

    // PATCH answers `{ meeting }`; anything else is revalidated, not guessed.
    if (body?.meeting) upsertMeetingRecord(body.meeting)
    else void loadDetail(selectedMeeting.id).catch(() => undefined)
    toast.success(dictionary.meetingRenamed)
    return true
  }

  async function deleteMeeting(): Promise<boolean> {
    if (!selectedMeeting) return false

    const meetingId = selectedMeeting.id
    const response = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}`, {
      method: "DELETE",
    }).catch(() => undefined)

    if (!response?.ok) {
      toast.error(dictionary.meetingDeleteFailed)
      return false
    }

    const position = meetingRecords.findIndex((meeting) => meeting.id === meetingId)
    const remaining = meetingRecords.filter((meeting) => meeting.id !== meetingId)
    const next = remaining[Math.min(Math.max(position, 0), remaining.length - 1)]

    detailCacheRef.current.delete(meetingId)
    if (deepLinkedMeetingRef.current?.id === meetingId) deepLinkedMeetingRef.current = null
    setMeetingRecords(remaining)
    setMeetingPage((page) => ({ ...page, total: Math.max(0, page.total - 1) }))
    if (next) selectMeeting(next.id)
    else setSelectedMeetingId("")
    toast.success(dictionary.meetingDeleted)
    void refreshMeetings(next?.id)
    return true
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

    upsertMeetingRecord(body.meeting)
    setTagsOpen(false)
    toast.success("Tags updated")
  }

  async function addToDefaultRoom() {
    if (!selectedMeeting) return

    const roomName = window.prompt("Room name:", selectedMeeting.contexts?.[0]?.name ?? "")
    if (!roomName?.trim()) return

    const contextsResponse = await fetch("/api/contexts")
    const contextsBody = await contextsResponse.json()
    let contextId = contextsBody.contexts?.find(
      (context: { name: string }) => context.name === roomName.trim()
    )?.id

    if (!contextId) {
      const response = await fetch("/api/contexts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: roomName.trim() }),
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
    void refreshSidebarRooms()
    toast.success(`Meeting added to "${roomName.trim()}"`)
  }

  async function refreshSidebarRooms() {
    const response = await fetch("/api/rooms").catch(() => undefined)

    if (!response?.ok) return

    const body = await response.json()
    setSidebarRooms(selectRecentRooms(body.rooms ?? []))
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

  function processMeeting(meetingToProcess: MeetingRecord | null = selectedMeeting) {
    if (!meetingToProcess) return

    startTransition(() => {
      void (async () => {
        const useArtifacts = hasImportableMeetArtifacts(meetingToProcess)
        const endpoint = useArtifacts
          ? `/api/meetings/${meetingToProcess.id}/artifacts/import`
          : `/api/meetings/${meetingToProcess.id}/process`
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: useArtifacts ? JSON.stringify({}) : undefined,
        })
        const body = await response.json()

        if (!response.ok) {
          toast.error(apiErrorMessage(body, dictionary, "Unable to process meeting"))
          return
        }

        setJobs((current) => [body.job, ...current])
        toast.success(
          body.message ??
            (useArtifacts
              ? "Google Meet artifact processing queued"
              : "Processing queued")
        )
        await refreshMeeting(meetingToProcess.id)
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
            body: JSON.stringify({}),
          })
          const body = await response.json()

          if (!response.ok) {
            toast.error(apiErrorMessage(body, dictionary, "Unable to sync Meet artifacts"))
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
            body: JSON.stringify({}),
          })
          const body = await response.json()

          if (!response.ok) {
            const message = apiErrorMessage(
              body,
              dictionary,
              "Unable to sync Google Workspace"
            )

            toast.error(message)
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
      void (async () => {
        try {
          const response = await fetch(`/api/meetings/${targetMeetingId}`)
          const body = await response.json()

          if (response.ok && body.meeting) {
            setMeetingRecords((current) => [
              listItemFromRecord(body.meeting as MeetingRecord),
              ...current.filter((meeting) => meeting.id !== targetMeetingId),
            ])
          }
          selectMeeting(targetMeetingId)
          setActivePanel("meetings")
        } catch {
          selectMeeting(targetMeetingId)
        }
      })()
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
          toast.error(body.error ?? "Unable to retry job")
          return
        }

        setJobs((current) => [body.job, ...current])
      })()
    })
  }

  // lg–2xl has two columns, so the rail wraps to a second row: keep the first
  // row a full viewport tall (inbox + meeting) and scroll down to the rail,
  // instead of letting the implicit row halve the meeting column.
  const defaultMeetingsViewClass =
    "grid min-h-[calc(100svh-3.5rem)] grid-cols-1 bg-surface-2 lg:h-[calc(100svh-3.5rem-var(--ms-dock-h,0px))] lg:min-h-0 lg:grid-cols-[330px_minmax(0,1fr)] lg:grid-rows-[100%] lg:auto-rows-max lg:overflow-y-auto ms-scrollbar 2xl:grid-cols-[330px_minmax(0,1fr)_270px] 2xl:overflow-hidden"

  const botEnabled = botSessions.enabled === true
  const meetingTitles = useMemo(
    () => Object.fromEntries(meetingRecords.map((meeting) => [meeting.id, meeting.title])),
    [meetingRecords]
  )
  const browserRecording =
    browserRecorder.state === "recording" && browserRecorder.startedAt
      ? {
          startedAt: browserRecorder.startedAt,
          meetingId: browserRecorder.meetingId,
          title: browserRecorder.meetingId ? (meetingTitles[browserRecorder.meetingId] ?? null) : null,
        }
      : null
  const dockEntries = dockEntriesFrom({
    sessions: botEnabled ? botSessions.byMeetingId : {},
    titles: meetingTitles,
    browser: browserRecording,
  })
  const botContext: BotSessionsContextValue = {
    enabled: botEnabled,
    byMeetingId: botSessions.byMeetingId,
    refresh: botSessions.refresh,
    onRecordFromBrowser: (meetingId) => void browserRecorder.start({ meetingId }),
    onImportDesktop: () => setDesktopOpen(true),
    onRequestStop: (session, title) =>
      session.meetingId && setStopTarget({ meetingId: session.meetingId, title }),
  }

  function handleDockStop(action: DockStopAction) {
    if (action.kind === "browser") {
      browserRecorder.stop()
      return
    }
    setStopTarget({ meetingId: action.meetingId, title: action.title })
  }

  async function confirmStopBot() {
    if (!stopTarget) return
    setStopBusy(true)
    const result = await botApi.stop(stopTarget.meetingId)

    setStopBusy(false)
    setStopTarget(null)
    if (!result.ok) {
      toast.error(dictionary[result.error])
      return
    }
    await botSessions.refresh()
  }

  const defaultMeetingsView = (
    <div className={defaultMeetingsViewClass}>
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
        botSessions={botEnabled ? botSessions.byMeetingId : undefined}
      />
      <MeetingWorkspace
        dictionary={dictionary}
        locale={locale}
        meeting={selectedMeeting}
        jobs={jobs}
        transcript={transcript}
        permissions={selectedPermissions}
        initialMs={
          deepLinkTime && deepLinkTime.meetingId === selectedMeeting?.id ? deepLinkTime.ms : undefined
        }
        onRename={renameMeeting}
        onDelete={deleteMeeting}
        onToggleActionItem={toggleActionItem}
        onReprocessMeeting={reprocessMeeting}
        onProcessMeeting={processMeeting}
        onRetryJob={retryJob}
        onOpenUpload={() => setUploadOpen(true)}
        onFindDriveRecordings={() => setDrivePickerOpen(true)}
        onSyncMeetArtifacts={syncMeetArtifacts}
        onSyncGoogle={() => syncGoogle("calendar")}
        onCheckSetup={() => setActivePanel("workspace")}
        onShareMeeting={openShareDialog}
        onVisibilityChanged={(visibility) =>
          selectedMeeting && setMeetingVisibility(selectedMeeting.id, visibility)
        }
        onToggleFavorite={toggleFavorite}
        onShowParticipants={openParticipantsDialog}
        onSpeakersChanged={handleSpeakersChanged}
        onAddToRoom={addToDefaultRoom}
        onCopyText={copyText}
      />
      <MeetingRightRail
        meeting={selectedMeeting}
        jobs={jobs}
        exporting={exporting}
        suggestingAgents={suggestingAgents}
        onEditTags={openTagsDialog}
        canManage={selectedPermissions.canManage}
        onExportRealizeOS={previewRealizeOSPayload}
        onProcessMeeting={processMeeting}
        onSuggestAgents={suggestAgents}
        onApproveAgentRun={approveAgentRun}
        analytics={
          selectedMeeting ? (
            <AnalyticsCard
              meetingId={selectedMeeting.id}
              dictionary={dictionary}
              locale={locale}
              canWrite={selectedPermissions.canWrite}
              refreshKey={`${selectedMeeting.transcriptVersion ?? 0}:${transcript.data?.version ?? 0}`}
            />
          ) : undefined
        }
        talkTime={
          selectedMeeting &&
          (transcript.data?.speakers ?? selectedMeeting.speakers ?? []).some(
            (speaker) => speaker.talkTimeMs > 0
          ) ? (
            <TalkTimePanel
              dictionary={dictionary}
              locale={locale}
              speakers={transcript.data?.speakers ?? selectedMeeting.speakers ?? []}
              participants={selectedMeeting.participantDetails ?? []}
              segments={transcript.data?.segments ?? []}
            />
          ) : undefined
        }
      />
    </div>
  )

  return (
    <BotSessionsProvider value={botContext}>
    <main
      className="ms-page min-h-svh pb-(--ms-dock-h) lg:fixed lg:inset-0 lg:h-svh lg:overflow-hidden lg:pb-0"
      style={{ "--ms-dock-h": `${dockHeight}px` } as CSSProperties}
    >
      <div className="grid min-h-svh grid-cols-1 lg:h-svh lg:min-h-0 lg:grid-cols-[220px_minmax(0,1fr)] lg:overflow-hidden">
        <MainSidebar
          dictionary={dictionary}
          locale={locale}
          activePanel={activePanel}
          onPanelChange={setActivePanel}
          rooms={sidebarRooms}
          user={user}
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
            onDesktopFileChange={handleDesktopFileChange}
            onRecordingReady={handleRecordingReady}
            onSync={syncGoogle}
            onFindDriveRecordings={() => setDrivePickerOpen(true)}
            darkMode={darkMode}
            onToggleDarkMode={toggleDarkMode}
            aiStatus={aiStatus}
            onInvite={() => setActivePanel("admin")}
            recorder={browserRecorder}
            recordingMeetingId={selectedMeeting?.id ?? null}
            desktopOpen={desktopOpen}
            onDesktopOpenChange={setDesktopOpen}
            onSendBot={
              botEnabled
                ? () => {
                    setJoinDialogReady(true)
                    setJoinOpen(true)
                  }
                : undefined
            }
          />
          {joinDialogReady ? (
            <JoinMeetingDialog
              dictionary={dictionary}
              open={joinOpen}
              onOpenChange={setJoinOpen}
              onJoined={(response) => {
                void refreshMeetings(response.meeting.id)
                selectMeeting(response.meeting.id)
                void botSessions.refresh()
              }}
            />
          ) : null}
          <StopBotDialog
            dictionary={dictionary}
            open={Boolean(stopTarget)}
            onOpenChange={(open) => {
              if (!open) setStopTarget(null)
            }}
            title={stopTarget?.title ?? null}
            busy={stopBusy}
            onConfirm={() => void confirmStopBot()}
          />
          <DriveRecordingPickerDrawer
            dictionary={dictionary}
            open={drivePickerOpen}
            onOpenChange={setDrivePickerOpen}
            onImported={handleDriveImported}
          />
          {shareOpen ? (
            <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4">
              <section className="w-full max-w-lg rounded-lg border border-line bg-surface p-5 shadow-xl">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">Share meeting</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Public link includes summary, decisions, action items,
                      participants, and transcript. The recording is included
                      only when you tick it below.
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setShareOpen(false)}>
                    Close
                  </Button>
                </div>
                {sharePrivateConfirm ? (
                  <div className="mt-4 grid gap-3 rounded-md border border-warn/40 bg-warn-soft p-3 text-sm leading-5 text-warn-text">
                    <p>{dictionary.sharePrivateWarning}</p>
                    <div>
                      <Button onClick={() => void createShareLink()}>
                        {dictionary.visibilityConfirm}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 rounded-md border border-line bg-surface-2 p-3">
                    <input
                      className="w-full bg-transparent text-sm outline-none"
                      dir="ltr"
                      readOnly
                      value={shareLink || "Creating link..."}
                    />
                  </div>
                )}
                {!sharePrivateConfirm && selectedMeeting?.mediaAssets?.length ? (
                  <label className="mt-3 flex items-start gap-2.5 text-sm">
                    <Checkbox
                      className="mt-0.5"
                      checked={Boolean(shareSections?.includes("media"))}
                      disabled={!shareSections}
                      onCheckedChange={(checked) => void setShareIncludesRecording(Boolean(checked))}
                    />
                    <span className="grid">
                      <span className="font-medium">{dictionary.shareIncludeRecording}</span>
                      <span className="text-xs text-fg-3">{dictionary.shareIncludeRecordingHint}</span>
                    </span>
                  </label>
                ) : null}
                {selectedDetail && !selectedDetail.meeting.summary?.overview ? (
                  <div className="mt-3 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs leading-5 text-warn-text">
                    This meeting has no generated summary yet. The public page
                    will still open, but it may only show metadata, participants,
                    and any transcript that exists.
                  </div>
                ) : null}
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
                  <Button
                    disabled={!shareLink}
                    variant="outline"
                    onClick={regenerateShareLink}
                    title={
                      shareLink
                        ? "Regenerate the public share token"
                        : "Create the first share link before regenerating"
                    }
                  >
                    Regenerate
                  </Button>
                  <Button
                    disabled={!shareLink}
                    variant="destructive"
                    onClick={revokeShareLink}
                    title={
                      shareLink
                        ? "Revoke this public share link"
                        : "No active public link to revoke"
                    }
                  >
                    Revoke
                  </Button>
                </div>
              </section>
            </div>
          ) : null}
          {payloadPreviewOpen ? (
            <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4">
              <section className="flex w-full max-w-3xl flex-col rounded-lg border border-line bg-surface p-5 shadow-xl" style={{ maxHeight: "80vh" }}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">RealizeOS payload preview</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Review the payload before sending to RealizeOS.
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setPayloadPreviewOpen(false)}>
                    Close
                  </Button>
                </div>
                <div className="ms-scrollbar mt-4 min-h-0 flex-1 overflow-auto rounded-md border border-line bg-surface-2 p-3">
                  <pre className="whitespace-pre-wrap text-xs leading-5 text-fg-2">
                    {payloadPreview}
                  </pre>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    onClick={() => copyText(payloadPreview, "Payload JSON")}
                    variant="outline"
                  >
                    Copy JSON
                  </Button>
                  <Button
                    onClick={exportRealizeOS}
                    disabled={exporting || payloadPreview === "Loading\u2026"}
                  >
                    Send export
                  </Button>
                </div>
              </section>
            </div>
          ) : null}
          {participantsOpen ? (
            <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4">
              <section className="w-full max-w-2xl rounded-lg border border-line bg-surface p-5 shadow-xl">
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
                      className="grid gap-2 rounded-md border border-line p-3 md:grid-cols-[1fr_1fr_110px_auto]"
                      key={participant.id}
                    >
                      <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                        Name
                        <input
                          className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-foreground"
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
                      </label>
                      <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                        Email
                        <input
                          className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-foreground"
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
                      </label>
                      <div className="grid gap-1 text-xs font-medium text-muted-foreground">
                        {dictionary.speakersTitle}
                        <span className="flex min-h-9 items-center rounded-md border border-dashed border-line px-3 text-sm text-foreground">
                          {(() => {
                            const mapped = (selectedMeeting?.speakers ?? []).filter(
                              (speaker) =>
                                speaker.participantId === participant.id &&
                                speaker.mappingStatus === "confirmed"
                            )

                            return mapped.length ? (
                              <bdi>
                                {mapped
                                  .map((speaker) =>
                                    localizeSpeakerLabel(speaker.label, dictionary.speakersGenericLabel)
                                  )
                                  .join(", ")}
                              </bdi>
                            ) : (
                              "—"
                            )
                          })()}
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        className="self-end"
                        onClick={() => saveParticipant(participant)}
                      >
                        Save
                      </Button>
                    </div>
                  )) : (
                    <div className="rounded-md border border-dashed border-line p-4 text-sm text-muted-foreground">
                      No participants were found for this meeting yet.
                    </div>
                  )}
                </div>
              </section>
            </div>
          ) : null}
          {tagsOpen ? (
            <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4">
              <section className="w-full max-w-md rounded-lg border border-line bg-surface p-5 shadow-xl">
                <h2 className="text-lg font-semibold">Edit tags</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Separate tags with commas.
                </p>
                <textarea
                  className="mt-4 min-h-28 w-full rounded-md border border-line bg-surface p-3 text-sm"
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
            : activePanel === "admin"
              ? <AdminPanel dictionary={dictionary} locale={locale} />
              : (
                <OperationalPage
                  dictionary={dictionary}
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
                  onOpenMeeting={selectMeeting}
                  onSyncMeetArtifacts={syncMeetArtifacts}
                  onProcessMeeting={(meetingId) => {
                    const meetingToProcess = meetingRecords.find(
                      (meeting) => meeting.id === meetingId
                    )
                    selectMeeting(meetingId)
                    processMeeting(meetingToProcess ?? null)
                  }}
                />
              )}
        </section>
      </div>
      <RecorderDock
        entries={dockEntries}
        dictionary={dictionary}
        onOpenMeeting={(meetingId) => {
          setActivePanel("meetings")
          selectMeeting(meetingId)
        }}
        onStop={handleDockStop}
        onHeightChange={setDockHeight}
      />
      {/* M6: Ctrl/Cmd+K command palette, available on every shell view. */}
      <CommandPaletteHost locale={locale} dictionary={dictionary} />
    </main>
    </BotSessionsProvider>
  )
}
