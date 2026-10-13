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
import { toast } from "sonner"

import { botApi } from "@/components/bot/bot-api"
import {
  BotSessionsProvider,
  type BotSessionsContextValue,
} from "@/components/bot/bot-sessions-context"
import { dockEntriesFrom, type DockStopAction } from "@/components/bot/recorder-dock-state"
import { useBotSessions } from "@/components/bot/use-bot-sessions"
import { useBrowserRecorder, type RecordingMeta } from "@/components/bot/use-browser-recorder"
import { CommandPaletteHost } from "@/components/command-palette"
import { useWorkspace } from "@/components/workspace-context"
import type { DriveImportResult } from "@/components/drive-recording-picker-drawer"
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
import { MeetingWorkspace, type MeetingPermissions } from "@/components/meeting-workspace"
import { useMeetingTranscript } from "@/components/transcript/use-meeting-transcript"
import type { ProviderStatusView } from "@/components/provider-health-panel"
import { OfflineBanner } from "@/components/pwa/offline-banner"
import { UploadQueueProvider } from "@/components/pwa/upload-queue-provider"
import { usePromptDialog } from "@/components/ui/prompt-dialog"
import { useShellUrl } from "@/hooks/use-shell-url"
import { ShareMeetingDialog } from "@/components/share/share-meeting-dialog"
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
import { withoutParams } from "@/lib/client/shell-navigation"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import { fillMessage, pluralMessage } from "@/lib/i18n/messages"
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

// M9 D6 bundle diet: everything below loads on first use, or after the
// meetings view, with a skeleton that keeps the final layout.
const railLoading = () => (
  <aside aria-busy="true" className="hidden min-h-0 animate-pulse border-s border-line bg-surface-2 2xl:block" />
)
const MeetingRightRail = dynamic(
  () => import("@/components/meeting-right-rail").then((mod) => mod.MeetingRightRail),
  { loading: railLoading }
)
const TalkTimePanel = dynamic(
  () => import("@/components/talk-time-panel").then((mod) => mod.TalkTimePanel),
  { loading: () => <div aria-busy="true" className="h-32 animate-pulse rounded-md bg-surface-2" /> }
)
const DriveRecordingPickerDrawer = dynamic(
  () => import("@/components/drive-recording-picker-drawer").then((mod) => mod.DriveRecordingPickerDrawer),
  { ssr: false }
)
const RecorderDock = dynamic(
  () => import("@/components/bot/recorder-dock").then((mod) => mod.RecorderDock),
  { ssr: false }
)
const StopBotDialog = dynamic(
  () => import("@/components/bot/stop-bot-dialog").then((mod) => mod.StopBotDialog),
  { ssr: false }
)
const PayloadPreviewDialog = dynamic(
  () => import("@/components/meeting-shell-dialogs").then((mod) => mod.PayloadPreviewDialog),
  { ssr: false }
)
const ParticipantsDialog = dynamic(
  () => import("@/components/meeting-shell-dialogs").then((mod) => mod.ParticipantsDialog),
  { ssr: false }
)
const TagsDialog = dynamic(
  () => import("@/components/meeting-shell-dialogs").then((mod) => mod.TagsDialog),
  { ssr: false }
)

/** Room names are short labels (M9 D2). */
const ROOM_NAME_MAX = 80

type MeetingPageState = {
  limit: number
  offset: number
  total: number
  hasMore: boolean
}

type DetailEntry = { meeting: MeetingRecord; permissions: MeetingPermissions }

/** A meeting detail read server-side (deep link outside the first page). */
export type ShellDetailEntry = DetailEntry

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

/**
 * A localized toast for a failed request. Server error text is English and
 * never shown; only known error codes map to their own message.
 */
function shellError(body: unknown, fallback: string, dictionary?: Pick<Dictionary, "googleNotConfigured">): string {
  const code = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined

  return code === "google_not_configured" && dictionary ? dictionary.googleNotConfigured : fallback
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
  workspaceId,
  initialDetail,
  unavailableMeetingId,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
  meetings: MeetingListItem[]
  rooms: SidebarRoom[]
  user?: SidebarUser
  /** The session's workspace (partitions the offline recording queue). */
  workspaceId?: string
  /** A `?meeting=` deep link outside the first page, read server-side. */
  initialDetail?: ShellDetailEntry
  /** A `?meeting=` deep link the user cannot see: inbox plus a notice. */
  unavailableMeetingId?: string
}) {
  // M9 D1: panel, meeting and `t` live in the URL; nothing mirrors them.
  const shell = useShellUrl(locale)
  const { navigate } = shell
  const activePanel: MainPanelKey = shell.state.panel
  const [sidebarRooms, setSidebarRooms] = useState(rooms)
  const [meetingRecords, setMeetingRecords] = useState(() =>
    initialDetail ? [listItemFromRecord(initialDetail.meeting), ...meetings] : meetings
  )
  const [unavailableId, setUnavailableId] = useState<string | null>(unavailableMeetingId ?? null)
  const { prompt, dialog: promptDialog } = usePromptDialog()
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [sortMode, setSortMode] = useState<MeetingSortMode>("smart")
  const [pageSize, setPageSize] = useState(5)
  const [pageOffset, setPageOffset] = useState(0)
  const [meetingPage, setMeetingPage] = useState<MeetingPageState>({
    limit: 5,
    offset: 0,
    total: meetings.length,
    hasMore: false,
  })
  const [meetingsLoading, setMeetingsLoading] = useState(false)
  const [detail, setDetail] = useState<DetailEntry | null>(initialDetail ?? null)
  const detailCacheRef = useRef(
    new Map<string, DetailEntry>(initialDetail ? [[initialDetail.meeting.id, initialDetail]] : [])
  )
  const detailAbortRef = useRef<AbortController | null>(null)
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
    onRecordingReady: (file, meta) => handleBrowserRecording(file, meta),
    userId: user?.id,
    workspaceId,
    recordingTitle: dictionary.shellBrowserRecordingTitle,
  })
  const [drivePickerOpen, setDrivePickerOpen] = useState(false)
  const [drivePickerReady, setDrivePickerReady] = useState(false)
  const [stopDialogReady, setStopDialogReady] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [participantsOpen, setParticipantsOpen] = useState(false)
  const [participants, setParticipants] = useState<MeetingParticipant[]>([])
  const [tagsOpen, setTagsOpen] = useState(false)
  const [tagDraft, setTagDraft] = useState("")
  const [payloadPreviewOpen, setPayloadPreviewOpen] = useState(false)
  const [payloadPreview, setPayloadPreview] = useState<string>("")
  const [payloadLoading, setPayloadLoading] = useState(false)
  // Lazy dialogs mount on first open and stay mounted (close animation).
  const [dialogsReady, setDialogsReady] = useState(false)
  const [darkMode, setDarkMode] = useState(false)
  const [isPending, startTransition] = useTransition()

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

  const setActivePanel = useCallback((panel: MainPanelKey) => navigate({ panel }), [navigate])

  // A panel change moves focus to the panel's heading (not on first paint).
  const panelRegionRef = useRef<HTMLDivElement>(null)
  const previousPanelRef = useRef(activePanel)

  useEffect(() => {
    if (previousPanelRef.current === activePanel) return
    previousPanelRef.current = activePanel

    // Lazy panels mount a frame later; try for a short while.
    let attempts = 0
    const focusHeading = () => {
      const heading = panelRegionRef.current?.querySelector<HTMLElement>("h1, h2")

      if (heading) {
        if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1")
        heading.focus({ preventScroll: false })
      } else if (attempts++ < 20) {
        window.setTimeout(focusHeading, 50)
      }
    }

    focusHeading()
  }, [activePanel])

  // `?record=1` (the PWA "New recording" shortcut) only OPENS the recorder
  // sheet. URL state is navigation: capture always needs the user's own click
  // on Record inside the sheet (no microphone request from a link). The
  // parameter is dropped at once so it never round-trips or replays.
  const recordRequested = shell.searchParams.get("record") === "1"
  const [recordSheetOpen, setRecordSheetOpen] = useState(false)

  useEffect(() => {
    if (!recordRequested) return
    window.history.replaceState(null, "", `${window.location.pathname}${withoutParams(window.location.search, ["record"])}`)
    queueMicrotask(() => setRecordSheetOpen(true))
  }, [recordRequested])
  function openDrivePicker() {
    setDrivePickerReady(true)
    setDrivePickerOpen(true)
  }

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

  // The URL's meeting, else the first row. A deep-linked meeting outside the
  // current page renders from its detail (read server-side or fetched).
  const urlMeetingId = shell.state.meeting
  const selectedMeetingId = urlMeetingId ?? meetingRecords[0]?.id ?? ""
  const selectedListItem: MeetingListItem | null =
    meetingRecords.find((meeting) => meeting.id === selectedMeetingId) ??
    (detail && detail.meeting.id === selectedMeetingId ? listItemFromRecord(detail.meeting) : null) ??
    (urlMeetingId ? null : (meetingRecords[0] ?? null))
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

        if (response.status === 404 || response.status === 403) {
          setUnavailableId(meetingId)
          return undefined
        }
        if (!response.ok || !body.meeting) throw new Error(dictionary.shellErrorRefreshMeeting)

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
    [dictionary.shellErrorRefreshMeeting, rememberDetail]
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

  const selectMeeting = useCallback(
    (meetingId: string) => {
      setUnavailableId(null)
      navigate({ panel: "meetings", meeting: meetingId, t: null })
    },
    [navigate]
  )

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
      throw new Error(dictionary.shellErrorRefreshMeeting)
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
    if (nextSelectedMeetingId) selectMeeting(nextSelectedMeetingId)
  }, [
    pageOffset,
    pageSize,
    query,
    selectMeeting,
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
        title: file.name.replace(/\.[^.]+$/, "") || dictionary.shellUploadedMeetingTitle,
        source: "upload",
        language: "mixed",
        startedAt: new Date().toISOString(),
        participants: [],
      }),
    })
    const body = await response.json()

    if (!response.ok) {
      throw new Error(dictionary.shellErrorCreateMeeting)
    }

    setMeetingRecords((current) =>
      [listItemFromRecord(body.meeting as MeetingRecord), ...current].slice(0, pageSize)
    )
    selectMeeting(body.meeting.id)
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
      throw new Error(dictionary.shellErrorUploadMedia)
    }

    setJobs((current) => [body.job, ...current])
    toast.success(dictionary.shellToastUploadQueued)
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
        title: file.name.replace(/\.[^.]+$/, "") || dictionary.shellDesktopRecordingTitle,
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
      throw new Error(dictionary.shellErrorImportDesktop)
    }

    if (body.meeting) {
      setMeetingRecords((current) =>
        [listItemFromRecord(body.meeting as MeetingRecord), ...current].slice(0, pageSize)
      )
      selectMeeting(body.meeting.id)
    }
    setJobs((current) => (body.job ? [body.job, ...current] : current))
    toast.success(dictionary.shellToastDesktopQueued)
    await refreshOperationalState()
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]

    if (!file) return
    toast.info(fillMessage(dictionary.shellToastUploading, { name: file.name }))
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
    toast.info(fillMessage(dictionary.shellToastImportingDesktop, { name: file.name }))
    startTransition(() =>
      void importDesktopFile(file).catch((error) => {
        toast.error(error.message)
      })
    )
    event.target.value = ""
  }

  /**
   * M9 D5: a recording for a meeting keeps the M7 path (upload to that
   * meeting); its offline-queue copy is dropped after success and uploads
   * through the idempotent ingest route (as its own meeting) if the direct
   * upload fails. A recording without a meeting (`?record=1`) goes through
   * the queue directly.
   */
  function handleBrowserRecording(file: File, meta: RecordingMeta) {
    const { meetingId, captureId } = meta
    const target =
      (meetingId ? meetingRecords.find((meeting) => meeting.id === meetingId) : undefined) ??
      (meetingId && selectedMeeting?.id === meetingId ? selectedMeeting : undefined)
    const queue = () =>
      user?.id && workspaceId
        ? import("@/lib/client/upload-queue/browser").then((browser) => browser.getUploadQueue(user.id as string, workspaceId))
        : Promise.resolve(null)

    toast.info(dictionary.shellToastRecordingSaved)
    if (captureId && !target) {
      void queue().then((uploadQueue) => uploadQueue?.flush({ force: true }))
      return
    }
    startTransition(() =>
      void uploadFile(file, target ?? selectedMeeting ?? undefined)
        .then(() => (captureId ? queue().then((uploadQueue) => uploadQueue?.remove(captureId)) : undefined))
        .catch((error) => {
          toast.error(error.message)
          if (captureId) void queue().then((uploadQueue) => uploadQueue?.flush({ force: true }))
        })
    )
  }

  function handleRecordingReady(file: File) {
    toast.info(dictionary.shellToastRecordingSaved)
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

    if (!response.ok) {
      toast.error(dictionary.shellErrorUpdateActionItem)
      return
    }

    await refreshMeeting()
  }

  async function previewRealizeOSPayload() {
    if (!selectedMeeting) return

    setPayloadPreview("")
    setPayloadLoading(true)
    setDialogsReady(true)
    setPayloadPreviewOpen(true)
    try {
      const response = await fetch(`/api/integrations/realizeos/preview/${selectedMeeting.id}`)
      const body = await response.json()

      if (!response.ok) {
        setPayloadPreview(JSON.stringify({ error: dictionary.shellErrorBuildPreview }, null, 2))
        return
      }

      setPayloadPreview(JSON.stringify(body, null, 2))
    } catch {
      setPayloadPreview(JSON.stringify({ error: dictionary.shellErrorFetchPreview }, null, 2))
    } finally {
      setPayloadLoading(false)
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
        toast.error(dictionary.shellErrorExportRealizeOS)
        return
      }

      setJobs((current) => [body.job, ...current])
      toast.success(dictionary.shellRealizeOSQueued)
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
        toast.error(dictionary.shellErrorSuggestAgents)
        return
      }

      await refreshMeeting(selectedMeeting.id)
      const count = body.suggestions?.length ?? 0

      toast.success(
        count ? pluralMessage(dictionary, locale, "shellAgentSuggestions", count) : dictionary.shellNoAgentSuggestions
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
      toast.error(dictionary.shellErrorApproveAgent)
      return
    }

    if (body.job) {
      setJobs((current) => [body.job, ...current])
    }
    await refreshMeeting(run.meetingId)
    await refreshOperationalState()
    toast.success(body.job ? dictionary.shellAgentApprovedQueued : dictionary.shellAgentApprovedPrepared)
  }

  async function copyText(text: string, label: string) {
    if (!text.trim()) {
      toast.info(fillMessage(dictionary.shellCopyEmpty, { label }))
      return
    }

    await navigator.clipboard.writeText(text)
    toast.success(fillMessage(dictionary.shellCopied, { label }))
  }

  function setMeetingVisibility(meetingId: string, visibility: MeetingVisibility) {
    setMeetingRecords((current) =>
      current.map((meeting) =>
        meeting.id === meetingId ? { ...meeting, visibility } : meeting
      )
    )
  }

  function openShareDialog() {
    if (!selectedMeeting) return

    setShareOpen(true)
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
      toast.error(dictionary.shellErrorFavorite)
      return
    }

    upsertMeetingRecord(body.meeting)
  }

  async function openParticipantsDialog() {
    if (!selectedMeeting) return

    setDialogsReady(true)
    setParticipantsOpen(true)
    const response = await fetch(
      `/api/meetings/${selectedMeeting.id}/participants`
    )
    const body = await response.json()

    if (!response.ok) {
      toast.error(dictionary.shellErrorLoadParticipants)
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
      toast.error(dictionary.shellErrorSaveParticipant)
      return
    }

    setParticipants((current) =>
      current.map((item) => (item.id === participant.id ? body.participant : item))
    )
    await refreshMeeting(participant.meetingId)
    toast.success(dictionary.shellParticipantUpdated)
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
    setMeetingRecords(remaining)
    setMeetingPage((page) => ({ ...page, total: Math.max(0, page.total - 1) }))
    // The deleted meeting's URL entry is replaced, so Back never returns to it.
    navigate({ meeting: next?.id ?? null, t: null }, { replace: true })
    toast.success(dictionary.meetingDeleted)
    void refreshMeetings(next?.id)
    return true
  }

  function openTagsDialog() {
    if (!selectedMeeting) return

    setTagDraft((selectedMeeting.tags ?? []).join(", "))
    setDialogsReady(true)
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
      toast.error(dictionary.shellErrorSaveTags)
      return
    }

    upsertMeetingRecord(body.meeting)
    setTagsOpen(false)
    toast.success(dictionary.shellTagsUpdated)
  }

  async function addToDefaultRoom() {
    if (!selectedMeeting) return

    const roomName = await prompt({
      title: dictionary.shellRoomPromptTitle,
      description: dictionary.shellRoomPromptDescription,
      label: dictionary.shellRoomNamePrompt,
      defaultValue: selectedMeeting.contexts?.[0]?.name ?? "",
      confirmLabel: dictionary.shellRoomPromptSubmit,
      maxLength: ROOM_NAME_MAX,
      validate: (value) =>
        !value
          ? dictionary.shellRoomNameRequired
          : Array.from(value).length > ROOM_NAME_MAX
            ? fillMessage(dictionary.shellRoomNameTooLong, { max: ROOM_NAME_MAX })
            : null,
    })
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
        toast.error(dictionary.shellErrorCreateRoom)
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
    if (!linkResponse.ok) {
      toast.error(dictionary.shellErrorAddToRoom)
      return
    }

    await refreshMeeting(selectedMeeting.id)
    void refreshSidebarRooms()
    toast.success(fillMessage(dictionary.shellAddedToRoom, { room: roomName.trim() }))
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
          toast.error(dictionary.shellErrorReprocess)
          return
        }

        setJobs((current) => [body.job, ...current])
        toast.success(dictionary.shellReprocessQueued)
        await refreshOperationalState()
      })().catch(() => toast.error(dictionary.shellErrorReprocess))
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
          toast.error(shellError(body, dictionary.shellErrorProcess, dictionary))
          return
        }

        setJobs((current) => [body.job, ...current])
        toast.success(useArtifacts ? dictionary.shellMeetArtifactsQueued : dictionary.shellProcessingQueued)
        await refreshMeeting(meetingToProcess.id)
        await refreshOperationalState()
      })().catch(() => toast.error(dictionary.shellErrorProcess))
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
            toast.error(shellError(body, dictionary.shellErrorSyncMeet, dictionary))
            return
          }

          toast.success(dictionary.shellMeetSyncChecked)
          await refreshOperationalState()
        } finally {
          setSyncing(false)
        }
      })().catch(() => {
        setSyncing(false)
        toast.error(dictionary.shellErrorSyncMeet)
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
            toast.error(shellError(body, dictionary.shellErrorSyncGoogle, dictionary))
            return
          }

          setJobs((current) => (body.job ? [body.job, ...current] : current))
          toast.success(target === "gmail" ? dictionary.shellGmailSyncQueued : dictionary.shellCalendarSyncQueued)
          await refreshOperationalState()
          await refreshMeetings()
        } finally {
          setSyncing(false)
        }
      })().catch(() => {
        setSyncing(false)
        toast.error(dictionary.shellErrorSyncGoogle)
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
          toast.error(dictionary.shellErrorRetryJob)
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
    onRequestStop: (session, title) => {
      if (!session.meetingId) return
      setStopDialogReady(true)
      setStopTarget({ meetingId: session.meetingId, title })
    },
  }

  function handleDockStop(action: DockStopAction) {
    if (action.kind === "browser") {
      browserRecorder.stop()
      return
    }
    setStopDialogReady(true)
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
      {unavailableId && unavailableId === urlMeetingId ? (
        <p role="status" className="col-span-full border-b border-line bg-warn-soft px-4 py-2 text-sm text-warn-text">
          {dictionary.shellMeetingUnavailable}
        </p>
      ) : null}
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
          shell.state.t !== null && shell.state.meeting === selectedMeeting?.id ? shell.state.t * 1000 : undefined
        }
        onRename={renameMeeting}
        onDelete={deleteMeeting}
        onToggleActionItem={toggleActionItem}
        onReprocessMeeting={reprocessMeeting}
        onProcessMeeting={processMeeting}
        onRetryJob={retryJob}
        onOpenUpload={() => setUploadOpen(true)}
        onFindDriveRecordings={openDrivePicker}
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

  const effectiveDockHeight = dockEntries.length ? dockHeight : 0

  return (
    <UploadQueueProvider userId={user?.id} workspaceId={workspaceId} onUploaded={() => void refreshMeetings()}>
    <BotSessionsProvider value={botContext}>
    <div
      className="ms-page min-h-svh pb-(--ms-dock-h) lg:fixed lg:inset-0 lg:h-svh lg:overflow-hidden lg:pb-0"
      style={{ "--ms-dock-h": `${effectiveDockHeight}px` } as CSSProperties}
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
        <main id="main-content" tabIndex={-1} className="min-w-0 outline-none lg:h-svh lg:overflow-hidden">
          <OfflineBanner />
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
            onFindDriveRecordings={openDrivePicker}
            darkMode={darkMode}
            onToggleDarkMode={toggleDarkMode}
            aiStatus={aiStatus}
            onInvite={() => setActivePanel("admin")}
            recorder={browserRecorder}
            recordingMeetingId={selectedMeeting?.id ?? null}
            recordOpen={recordSheetOpen}
            onRecordOpenChange={setRecordSheetOpen}
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
          {stopDialogReady ? (
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
          ) : null}
          {drivePickerReady ? (
            <DriveRecordingPickerDrawer
              dictionary={dictionary}
              open={drivePickerOpen}
              onOpenChange={setDrivePickerOpen}
              onImported={handleDriveImported}
            />
          ) : null}
          {shareOpen && selectedMeeting ? (
            <ShareMeetingDialog
              key={selectedMeeting.id}
              meeting={selectedMeeting}
              open={shareOpen}
              onOpenChange={setShareOpen}
              dictionary={dictionary}
              hasSummary={!selectedDetail || Boolean(selectedDetail.meeting.summary?.overview)}
              onVisibilityChange={setMeetingVisibility}
            />
          ) : null}
          {dialogsReady ? (
            <>
              <PayloadPreviewDialog
                dictionary={dictionary}
                open={payloadPreviewOpen}
                onOpenChange={setPayloadPreviewOpen}
                payload={payloadPreview}
                loading={payloadLoading}
                exporting={exporting}
                onCopy={() => void copyText(payloadPreview, dictionary.shellPayloadLabel)}
                onSend={() => void exportRealizeOS()}
              />
              <ParticipantsDialog
                dictionary={dictionary}
                open={participantsOpen}
                onOpenChange={setParticipantsOpen}
                meeting={selectedMeeting}
                participants={participants}
                onChange={(participant) =>
                  setParticipants((current) =>
                    current.map((item) => (item.id === participant.id ? participant : item))
                  )
                }
                onSave={(participant) => void saveParticipant(participant)}
              />
              <TagsDialog
                dictionary={dictionary}
                open={tagsOpen}
                onOpenChange={setTagsOpen}
                value={tagDraft}
                onValueChange={setTagDraft}
                onSave={() => void saveTags()}
              />
            </>
          ) : null}
          {promptDialog}
          <div ref={panelRegionRef} className="contents">
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
                  onFindDriveRecordings={openDrivePicker}
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
          </div>
        </main>
      </div>
      {dockEntries.length ? (
        <RecorderDock
          entries={dockEntries}
          dictionary={dictionary}
          onOpenMeeting={selectMeeting}
          onStop={handleDockStop}
          onHeightChange={setDockHeight}
        />
      ) : null}
      {/* M6: Ctrl/Cmd+K command palette, available on every shell view. */}
      <CommandPaletteHost locale={locale} dictionary={dictionary} />
    </div>
    </BotSessionsProvider>
    </UploadQueueProvider>
  )
}
