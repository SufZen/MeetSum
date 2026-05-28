"use client"

import {
  BotIcon,
  BookOpenIcon,
  CloudIcon,
  DatabaseIcon,
  FileAudioIcon,
  KeyRoundIcon,
  LinkIcon,
  RadioTowerIcon,
  SearchIcon,
  SendIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react"
import type { ReactNode } from "react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { JobActivityCenter } from "@/components/job-activity-center"
import { JobRecoveryPanel } from "@/components/job-recovery-panel"
import { ProviderHealthPanel, type ProviderStatusView } from "@/components/provider-health-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import { WorkspaceSyncPanel, type WorkspaceStatusView } from "@/components/workspace-sync-panel"
import type { MainPanelKey } from "@/components/main-sidebar"
import { SUPPORTED_LOCALES, type SupportedLocale } from "@/lib/i18n/locales"
import type { JobRecord, MeetingRecord } from "@/lib/meetings/repository"

type MemorySearchResult = {
  id: string
  title: string
  startedAt: string
  status: MeetingRecord["status"]
  tags: string[]
  overview: string
  actionItems: Array<{ id: string; title: string; status: string }>
  transcriptMatches: Array<{ id: string; speaker: string; startMs: number; text: string }>
  matches: MemoryCitationView[]
  matchCount: number
}

type MemoryCitationView = {
  meetingId: string
  meetingTitle: string
  source: "summary" | "decision" | "action_item" | "transcript" | "tag"
  text: string
  segmentId?: string
  actionItemId?: string
  startMs?: number
}

type RoomResult = {
  id: string
  name: string
  description?: string
  meetingCount: number
}

type RoomDetailView = {
  room: RoomResult
  stats: {
    meetings: number
    completedMeetings: number
    processingMeetings: number
    openTasks: number
    participants: number
    artifacts: number
  }
  meetings: Array<{
    id: string
    title: string
    status: MeetingRecord["status"]
    startedAt: string
    overview: string
    openTasks: number
    participants: number
    artifacts: number
  }>
  openTasks: Array<{
    id: string
    title: string
    owner?: string
    status: string
    priority?: string
    meetingId: string
    meetingTitle: string
  }>
  participants: Array<{
    name: string
    email?: string
    role: string
    meetingCount: number
  }>
  artifacts: Array<{
    id: string
    meetingId: string
    meetingTitle: string
    artifactType: "recording" | "transcript" | "smart_notes"
    artifactName: string
  }>
}

type WebhookEventName =
  | "meeting.completed"
  | "summary.created"
  | "action_item.created"
  | "meeting.process_failed"
  | "realizeos.export.sent"
  | "realizeos.export.failed"

type WebhookSubscriptionView = {
  id: string
  url: string
  events: WebhookEventName[]
  enabled: boolean
  secretRef?: string
  createdAt: string
}

type WebhookDeliveryView = {
  id: string
  subscriptionId: string
  subscriptionUrl: string
  eventName: string
  status: string
  attempts: number
  responseStatus?: number
  responseBody?: string
  lastError?: string
  createdAt: string
}

type MediaAssetView = {
  id: string
  meetingId: string
  meetingTitle: string
  filename?: string
  contentType: string
  sizeBytes: number
  retention: "audio" | "video"
  createdAt: string
}

type RealizeOSStatusView = {
  configured: boolean
  baseUrl?: string
  path: string
  authConfigured: boolean
  mode: string
  message: string
}

type RealizeOSExportView = {
  id: string
  meetingId: string
  status: string
  response?: Record<string, unknown>
  lastError?: string
  createdAt: string
}

type MeetArtifactView = {
  id: string
  artifactType: "recording" | "transcript" | "smart_notes"
  artifactName: string
  state?: string
  driveFileName?: string
  documentName?: string
}

type MeetConferenceRecordView = {
  id: string
  conferenceRecordName: string
  meetingId?: string
  meetingTitle?: string
  calendarTitle?: string
  startTime?: string
  artifacts: MeetArtifactView[]
}

type MeetArtifactStatusView = {
  setup?: {
    authorized: boolean
    message?: string
    requiredScope?: string
  }
  conferenceRecords: unknown[]
  persistedRecords: MeetConferenceRecordView[]
}

type AppSettingsView = {
  defaultLocale: SupportedLocale
  meetingLanguageMode: "auto" | SupportedLocale
  aiProviderPreference: "gemini-developer-api" | "vertex-ai"
  summaryTemplate: "general" | "sales" | "real-estate" | "product" | "operations" | "legal"
  googleArtifactsFirst: boolean
  pwaRecorderEnabled: boolean
  autoProcessImportedMedia: boolean
  publicSharingEnabled: boolean
  shareTranscriptByDefault: boolean
  shareActionsByDefault: boolean
  audioRetentionDays: number
  retainVideoByDefault: boolean
  requireApiKeyForMachines: boolean
}

const webhookEvents: Array<{ value: WebhookEventName; label: string }> = [
  { value: "meeting.completed", label: "Meeting completed" },
  { value: "summary.created", label: "Summary created" },
  { value: "action_item.created", label: "Action item created" },
  { value: "meeting.process_failed", label: "Processing failed" },
  { value: "realizeos.export.sent", label: "RealizeOS sent" },
  { value: "realizeos.export.failed", label: "RealizeOS failed" },
]

const localeLabels: Record<SupportedLocale, string> = {
  en: "English",
  he: "Hebrew",
  pt: "Portuguese",
  es: "Spanish",
  it: "Italian",
}

const defaultSettings: AppSettingsView = {
  defaultLocale: "en",
  meetingLanguageMode: "auto",
  aiProviderPreference: "gemini-developer-api",
  summaryTemplate: "general",
  googleArtifactsFirst: true,
  pwaRecorderEnabled: true,
  autoProcessImportedMedia: true,
  publicSharingEnabled: true,
  shareTranscriptByDefault: true,
  shareActionsByDefault: true,
  audioRetentionDays: 180,
  retainVideoByDefault: false,
  requireApiKeyForMachines: true,
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"

  const units = ["B", "KB", "MB", "GB"]
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  )
  const value = bytes / 1024 ** index

  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function formatShortDate(value?: string) {
  if (!value) return "No time"

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return "No time"

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

function formatArtifactType(value: MeetArtifactView["artifactType"]) {
  if (value === "smart_notes") return "Smart notes"

  return value[0].toUpperCase() + value.slice(1)
}

function formatMemoryTime(ms?: number) {
  if (ms === undefined) return undefined
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

function formatMemorySource(value: MemoryCitationView["source"]) {
  if (value === "action_item") return "Action"

  return value.replace("_", " ")
}

function PageFrame({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="ms-scrollbar min-h-[calc(100svh-3.5rem)] overflow-y-auto bg-[var(--surface-subtle)] p-3 lg:h-[calc(100svh-3.5rem)] lg:p-5">
      <div className="mx-auto grid max-w-7xl gap-4">
        <header className="flex flex-col gap-3 px-1 py-1 lg:flex-row lg:items-end lg:justify-between">
          <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--primary)]">
            {eyebrow}
          </div>
          <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          <p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted-foreground">
            {description}
          </p>
          </div>
        </header>
        {children}
      </div>
    </div>
  )
}

function OpsCard({
  icon: Icon,
  title,
  description,
  status,
  children,
}: {
  icon: typeof SearchIcon
  title: string
  description: string
  status?: string
  children?: ReactNode
}) {
  return (
    <section className="ms-card p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="grid size-8 place-items-center rounded-md bg-[var(--selected)] text-[var(--primary)]">
            <Icon aria-hidden="true" className="size-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground">{title}</h2>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">{description}</p>
          </div>
        </div>
        {status && (
          <Badge className="rounded-md bg-[var(--selected)] text-[var(--primary)]">{status}</Badge>
        )}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </section>
  )
}

function ManualBlock({
  title,
  items,
}: {
  title: string
  items: string[]
}) {
  return (
    <section className="ms-card p-4">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <div className="mt-3 grid gap-2">
        {items.map((item) => (
          <div
            key={item}
            className="rounded-md border border-[var(--divider)] bg-[var(--surface-subtle)] px-3 py-2 text-sm leading-6 text-muted-foreground"
          >
            {item}
          </div>
        ))}
      </div>
    </section>
  )
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          {description}
        </p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function OperationalPage({
  panel,
  meetings,
  jobs,
  providers,
  workspaceStatus,
  syncing,
  query,
  onQueryChange,
  onSyncCalendar,
  onFindDriveRecordings,
  onRetryJob,
  onOpenMeeting,
  onProcessMeeting,
  onSyncMeetArtifacts,
}: {
  panel: MainPanelKey
  meetings: MeetingRecord[]
  jobs: JobRecord[]
  providers: ProviderStatusView[]
  workspaceStatus?: WorkspaceStatusView
  syncing?: boolean
  query: string
  onQueryChange: (value: string) => void
  onSyncCalendar: () => void
  onFindDriveRecordings: () => void
  onRetryJob: (job: JobRecord) => void
  onOpenMeeting: (meetingId: string) => void
  onProcessMeeting: (meetingId: string) => void
  onSyncMeetArtifacts: () => void
}) {
  const [memoryAnswer, setMemoryAnswer] = useState("")
  const [memoryQuestion, setMemoryQuestion] = useState("")
  const [memoryCitations, setMemoryCitations] = useState<MemoryCitationView[]>([])
  const [memoryResults, setMemoryResults] = useState<MemorySearchResult[]>([])
  const [filterRoom, setFilterRoom] = useState("")
  const [filterTag, setFilterTag] = useState("")
  const [filterParticipant, setFilterParticipant] = useState("")
  const [filterLanguage, setFilterLanguage] = useState("")
  const [rooms, setRooms] = useState<RoomResult[]>([])
  const [selectedRoomId, setSelectedRoomId] = useState("")
  const [roomDetail, setRoomDetail] = useState<RoomDetailView>()
  const [roomLoading, setRoomLoading] = useState(false)
  const [newRoomName, setNewRoomName] = useState("")
  const [roomCreating, setRoomCreating] = useState(false)
  const [webhookUrl, setWebhookUrl] = useState("")
  const [webhookEventSelection, setWebhookEventSelection] =
    useState<WebhookEventName[]>(["meeting.completed", "summary.created"])
  const [webhookSubscriptions, setWebhookSubscriptions] = useState<
    WebhookSubscriptionView[]
  >([])
  const [webhookDeliveries, setWebhookDeliveries] = useState<
    WebhookDeliveryView[]
  >([])
  const [webhookLoading, setWebhookLoading] = useState(false)
  const [realizeOSStatus, setRealizeOSStatus] = useState<RealizeOSStatusView>()
  const [realizeOSExports, setRealizeOSExports] = useState<RealizeOSExportView[]>([])
  const [mediaAssets, setMediaAssets] = useState<MediaAssetView[]>([])
  const [storageLoading, setStorageLoading] = useState(false)
  const [settings, setSettings] = useState<AppSettingsView>(defaultSettings)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsSection, setSettingsSection] = useState("Recording & Privacy")
  const [meetArtifacts, setMeetArtifacts] = useState<MeetArtifactStatusView>()
  const [meetArtifactsLoading, setMeetArtifactsLoading] = useState(false)
  const [meetArtifactsError, setMeetArtifactsError] = useState("")

  useEffect(() => {
    if (panel !== "memory") return

    const timeoutId = window.setTimeout(() => {
      const params = new URLSearchParams({
        query: query.trim(),
        limit: "8",
      })
      if (filterRoom) params.set("roomId", filterRoom)
      if (filterTag) params.set("tag", filterTag)
      if (filterParticipant) params.set("participant", filterParticipant)
      if (filterLanguage) params.set("language", filterLanguage)

      void fetch(`/api/memory/search?${params}`)
        .then((response) => response.json())
        .then((body) => setMemoryResults(body.results ?? []))
        .catch(() => setMemoryResults([]))
      void fetch("/api/rooms")
        .then((response) => response.json())
        .then((body) => setRooms(body.rooms ?? []))
        .catch(() => setRooms([]))
    }, query.trim() ? 250 : 0)

    return () => window.clearTimeout(timeoutId)
  }, [panel, query, filterRoom, filterTag, filterParticipant, filterLanguage])

  useEffect(() => {
    if (panel !== "automations") return

    void refreshAutomations()
  }, [panel])

  useEffect(() => {
    if (panel !== "storage") return

    void refreshStorage()
  }, [panel])

  useEffect(() => {
    if (panel !== "settings") return

    void refreshSettings()
  }, [panel])

  useEffect(() => {
    if (panel !== "workspace") return

    void refreshMeetArtifacts()
  }, [panel])

  async function askMemory() {
    if (!memoryQuestion.trim()) return

    const response = await fetch("/api/memory/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: memoryQuestion }),
    })
    const body = await response.json()

    if (!response.ok) {
      toast.error(body.error ?? "Unable to ask memory")
      return
    }

    setMemoryAnswer(body.answer ?? "No answer returned")
    setMemoryCitations(Array.isArray(body.citations) ? body.citations : [])
  }

  async function openRoom(roomId: string) {
    setSelectedRoomId(roomId)
    setRoomLoading(true)
    try {
      const response = await fetch(`/api/rooms/${roomId}`)
      const body = await response.json()

      if (!response.ok) {
        throw new Error(body.error ?? "Unable to load room")
      }

      setRoomDetail(body)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load room")
      setRoomDetail(undefined)
    } finally {
      setRoomLoading(false)
    }
  }

  async function createRoom() {
    if (!newRoomName.trim()) return

    setRoomCreating(true)
    try {
      const response = await fetch("/api/contexts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newRoomName.trim() }),
      })
      const body = await response.json()

      if (!response.ok) {
        throw new Error(body.error ?? "Unable to create room")
      }

      toast.success(`Room "${newRoomName.trim()}" created`)
      setNewRoomName("")
      // Refresh rooms list
      const roomsResponse = await fetch("/api/rooms")
      const roomsBody = await roomsResponse.json()
      setRooms(roomsBody.rooms ?? [])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to create room")
    } finally {
      setRoomCreating(false)
    }
  }

  async function copyAutomationText(value: string, label: string) {
    await navigator.clipboard.writeText(value)
    toast.success(`${label} copied`)
  }

  async function refreshAutomations() {
    setWebhookLoading(true)
    try {
      const [
        subscriptionsResponse,
        deliveriesResponse,
        realizeOSStatusResponse,
        realizeOSExportsResponse,
      ] = await Promise.all([
        fetch("/api/webhooks/subscriptions"),
        fetch("/api/webhooks/deliveries?limit=12"),
        fetch("/api/integrations/realizeos/status"),
        fetch("/api/integrations/realizeos/exports?limit=8"),
      ])
      const subscriptionsBody = await subscriptionsResponse.json()
      const deliveriesBody = await deliveriesResponse.json()
      const realizeOSStatusBody = await realizeOSStatusResponse.json()
      const realizeOSExportsBody = await realizeOSExportsResponse.json()

      if (!subscriptionsResponse.ok) {
        throw new Error(
          subscriptionsBody.error ?? "Unable to load webhook subscriptions"
        )
      }

      if (!deliveriesResponse.ok) {
        throw new Error(deliveriesBody.error ?? "Unable to load webhook history")
      }

      setWebhookSubscriptions(subscriptionsBody.subscriptions ?? [])
      setWebhookDeliveries(deliveriesBody.deliveries ?? [])
      if (realizeOSStatusResponse.ok) {
        setRealizeOSStatus(realizeOSStatusBody.status)
      }
      if (realizeOSExportsResponse.ok) {
        setRealizeOSExports(realizeOSExportsBody.exports ?? [])
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to refresh automations"
      )
    } finally {
      setWebhookLoading(false)
    }
  }

  function toggleWebhookEvent(eventName: WebhookEventName) {
    setWebhookEventSelection((current) => {
      if (current.includes(eventName)) {
        const next = current.filter((event) => event !== eventName)
        return next.length ? next : current
      }

      return [...current, eventName]
    })
  }

  async function createWebhookSubscription() {
    if (!webhookUrl.trim()) {
      toast.error("Webhook URL is required")
      return
    }

    setWebhookLoading(true)
    try {
      const response = await fetch("/api/webhooks/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: webhookUrl.trim(),
          events: webhookEventSelection,
        }),
      })
      const body = await response.json()

      if (!response.ok) {
        throw new Error(body.error ?? "Unable to create webhook subscription")
      }

      setWebhookUrl("")
      toast.success("Webhook subscription created")
      await refreshAutomations()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to create subscription"
      )
    } finally {
      setWebhookLoading(false)
    }
  }

  async function setWebhookEnabled(subscription: WebhookSubscriptionView) {
    setWebhookLoading(true)
    try {
      const response = await fetch(`/api/webhooks/subscriptions/${subscription.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !subscription.enabled }),
      })
      const body = await response.json()

      if (!response.ok) {
        throw new Error(body.error ?? "Unable to update webhook subscription")
      }

      toast.success(subscription.enabled ? "Webhook paused" : "Webhook enabled")
      await refreshAutomations()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to update subscription"
      )
    } finally {
      setWebhookLoading(false)
    }
  }

  async function sendWebhookTest(subscription?: WebhookSubscriptionView) {
    if (!subscription && !webhookUrl.trim()) {
      toast.error("Add a webhook URL or choose an existing subscription")
      return
    }

    setWebhookLoading(true)
    try {
      const response = await fetch("/api/webhooks/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          subscription
            ? { subscriptionId: subscription.id }
            : { url: webhookUrl.trim(), eventName: webhookEventSelection[0] }
        ),
      })
      const body = await response.json()

      if (!response.ok) {
        throw new Error(body.error ?? "Webhook test failed")
      }

      toast.success(`Webhook test sent (${body.responseStatus})`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Webhook test failed")
    } finally {
      setWebhookLoading(false)
    }
  }

  async function retryWebhookDelivery(delivery: WebhookDeliveryView) {
    setWebhookLoading(true)
    try {
      const response = await fetch(`/api/webhooks/deliveries/${delivery.id}/retry`, {
        method: "POST",
      })
      const body = await response.json()

      if (!response.ok) {
        throw new Error(body.error ?? "Unable to retry webhook delivery")
      }

      toast.success("Webhook delivery retried")
      await refreshAutomations()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to retry delivery"
      )
    } finally {
      setWebhookLoading(false)
    }
  }

  async function retryRealizeOSExport(run: RealizeOSExportView) {
    setWebhookLoading(true)
    try {
      const response = await fetch(
        `/api/integrations/realizeos/exports/${run.id}/retry`,
        { method: "POST" }
      )
      const body = await response.json()

      if (!response.ok) {
        throw new Error(body.error ?? "Unable to retry RealizeOS export")
      }

      toast.success("RealizeOS export retried")
      await refreshAutomations()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to retry RealizeOS export"
      )
    } finally {
      setWebhookLoading(false)
    }
  }

  async function refreshStorage() {
    setStorageLoading(true)
    try {
      const response = await fetch("/api/storage/media-assets?limit=50")
      const body = await response.json()

      if (!response.ok) {
        throw new Error(body.error ?? "Unable to load media assets")
      }

      setMediaAssets(body.assets ?? [])
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to refresh storage"
      )
    } finally {
      setStorageLoading(false)
    }
  }

  async function deleteStoredMedia(asset: MediaAssetView) {
    const confirmed = window.confirm(
      `Delete ${asset.filename ?? "this media asset"}? Transcripts and summaries stay in MeetSum.`
    )

    if (!confirmed) return

    setStorageLoading(true)
    try {
      const response = await fetch(`/api/storage/media-assets/${asset.id}`, {
        method: "DELETE",
      })
      const body = await response.json()

      if (!response.ok) {
        throw new Error(body.error ?? "Unable to delete media asset")
      }

      toast.success("Media asset deleted")
      await refreshStorage()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to delete media asset"
      )
    } finally {
      setStorageLoading(false)
    }
  }

  async function refreshSettings() {
    setSettingsLoading(true)
    try {
      const response = await fetch("/api/settings")
      const body = await response.json()

      if (!response.ok) {
        throw new Error(body.error ?? "Unable to load settings")
      }

      setSettings({ ...defaultSettings, ...(body.settings ?? {}) })
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to refresh settings"
      )
    } finally {
      setSettingsLoading(false)
    }
  }

  async function refreshMeetArtifacts() {
    setMeetArtifactsLoading(true)
    try {
      const response = await fetch("/api/google/meet/artifacts?limit=10")
      const body = await response.json()

      if (!response.ok) {
        throw new Error(body.error ?? "Unable to load Meet artifact status")
      }

      setMeetArtifactsError("")
      setMeetArtifacts({
        setup: body.setup,
        conferenceRecords: body.conferenceRecords ?? [],
        persistedRecords: body.persistedRecords ?? [],
      })
    } catch (error) {
      setMeetArtifactsError(
        error instanceof Error
          ? error.message
          : "Unable to refresh Meet artifact status"
      )
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to refresh Meet artifact status"
      )
    } finally {
      setMeetArtifactsLoading(false)
    }
  }

  async function syncMeetArtifactsAndRefresh() {
    setMeetArtifactsLoading(true)
    setMeetArtifactsError("")
    try {
      const response = await fetch("/api/google/meet/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 10 }),
      })
      const body = await response.json()

      if (!response.ok) {
        throw new Error(body.error ?? "Unable to sync Meet artifacts")
      }

      toast.success(body.message ?? "Meet artifacts synced")
      await refreshMeetArtifacts()
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to sync Meet artifacts"

      setMeetArtifactsError(message)
      toast.error(message)
      await refreshMeetArtifacts()
    } finally {
      setMeetArtifactsLoading(false)
    }
  }

  async function saveSettingsPatch(patch: Partial<AppSettingsView>) {
    const optimistic = { ...settings, ...patch }

    setSettings(optimistic)
    setSettingsLoading(true)
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      })
      const body = await response.json()

      if (!response.ok) {
        throw new Error(body.error ?? "Unable to update settings")
      }

      setSettings({ ...defaultSettings, ...(body.settings ?? {}) })
      toast.success("Settings saved")
    } catch (error) {
      setSettings(settings)
      toast.error(
        error instanceof Error ? error.message : "Unable to save settings"
      )
    } finally {
      setSettingsLoading(false)
    }
  }

  if (panel === "workspace") {
    return (
      <PageFrame
        eyebrow="Google-first intake"
        title="Workspace command center"
        description="Calendar creates schedule context, Drive imports are operator-selected, and Meet artifacts are the preferred live-meeting capture path."
      >
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(340px,0.9fr)]">
          <WorkspaceSyncPanel
            status={workspaceStatus}
            syncing={syncing}
            onSyncAll={onSyncCalendar}
            onSyncMeetArtifacts={onSyncMeetArtifacts}
          />
          <div className="grid gap-4">
            <OpsCard
              icon={RadioTowerIcon}
              title="Live meeting capture"
              description="V1 uses native Google Meet recordings, transcripts, and smart notes. MeetSum imports artifacts after the meeting and does not join as a bot yet."
              status={
                meetArtifacts?.setup?.authorized
                  ? "Artifacts authorized"
                  : "Google artifacts first"
              }
            >
              <div className="grid gap-2 text-sm text-muted-foreground">
                <div className="flex items-center justify-between rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-3">
                  <span>Recording / transcript / smart notes readiness</span>
                  <Badge
                    variant="outline"
                    className={
                      meetArtifacts?.setup?.authorized
                        ? "rounded-md border-[var(--status-success)] text-[var(--status-success)]"
                        : "rounded-md"
                    }
                  >
                    {meetArtifacts?.setup?.authorized ? "authorized" : "checklist"}
                  </Badge>
                </div>
                {meetArtifacts?.setup?.message ? (
                  <div className="rounded-md border border-[var(--status-warning)]/40 bg-[var(--surface-subtle)] px-3 py-2 text-xs leading-5 text-[var(--status-warning)]">
                    {meetArtifacts.setup.message}
                  </div>
                ) : null}
                {meetArtifactsError ? (
                  <div className="rounded-md border border-[var(--status-error)]/40 bg-[var(--tag-action)] px-3 py-2 text-xs leading-5 text-[var(--tag-action-fg)]">
                    {meetArtifactsError}
                  </div>
                ) : null}
                {meetArtifacts ? (
                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded-md border border-[var(--divider)] bg-[var(--surface-subtle)] p-2">
                      <div className="text-xs text-muted-foreground">Live records</div>
                      <div className="mt-1 font-semibold text-foreground">
                        {meetArtifacts.conferenceRecords.length}
                      </div>
                    </div>
                    <div className="rounded-md border border-[var(--divider)] bg-[var(--surface-subtle)] p-2">
                      <div className="text-xs text-muted-foreground">Persisted</div>
                      <div className="mt-1 font-semibold text-foreground">
                        {meetArtifacts.persistedRecords.length}
                      </div>
                    </div>
                    <div className="rounded-md border border-[var(--divider)] bg-[var(--surface-subtle)] p-2">
                      <div className="text-xs text-muted-foreground">Artifacts</div>
                      <div className="mt-1 font-semibold text-foreground">
                        {meetArtifacts.persistedRecords.reduce(
                          (total, record) => total + record.artifacts.length,
                          0
                        )}
                      </div>
                    </div>
                  </div>
                ) : null}
                <Button className="h-10 w-full" variant="outline" onClick={onFindDriveRecordings}>
                  <FileAudioIcon data-icon="inline-start" className="size-4" />
                  Find Drive recordings
                </Button>
                <Button
                  className="h-10 w-full"
                  variant="outline"
                  disabled={meetArtifactsLoading || syncing}
                  onClick={syncMeetArtifactsAndRefresh}
                >
                  <RadioTowerIcon data-icon="inline-start" className="size-4" />
                  {meetArtifactsLoading ? "Checking artifacts..." : "Sync Meet artifacts"}
                </Button>
                {meetArtifacts?.persistedRecords.length ? (
                  <div className="mt-2 grid gap-2">
                    {meetArtifacts.persistedRecords.slice(0, 4).map((record) => (
                      <div
                        key={record.id}
                        className="rounded-md border border-[var(--divider)] bg-[var(--surface-subtle)] p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-foreground">
                              {record.meetingTitle ??
                                record.calendarTitle ??
                                record.conferenceRecordName}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {formatShortDate(record.startTime)}
                            </div>
                          </div>
                          <Badge variant="outline" className="shrink-0 rounded-md">
                            {record.artifacts.length} artifacts
                          </Badge>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {record.artifacts.length ? (
                            record.artifacts.slice(0, 5).map((artifact) => (
                              <span
                                key={artifact.id}
                                className="rounded-sm bg-[var(--selected)] px-2 py-0.5 text-[11px] font-medium text-[var(--primary)]"
                              >
                                {formatArtifactType(artifact.artifactType)}
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              No recordings/transcripts returned for this record yet.
                            </span>
                          )}
                        </div>
                        {record.meetingId && record.artifacts.length ? (
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8"
                              onClick={() => onOpenMeeting(record.meetingId!)}
                            >
                              Open meeting
                            </Button>
                            <Button
                              size="sm"
                              className="h-8"
                              onClick={() => onProcessMeeting(record.meetingId!)}
                            >
                              Process artifacts
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </OpsCard>
            <ProviderHealthPanel providers={providers} />
          </div>
          <div className="xl:col-span-2">
            <section className="ms-card grid gap-3 p-4">
              <h3 className="text-sm font-semibold">Meeting pipeline</h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(
                  [
                    ["Completed", meetings.filter((m) => m.status === "completed").length, "bg-[var(--status-success)]/10 text-[var(--status-success)]"],
                    ["Processing", meetings.filter((m) => ["media_found", "media_uploaded", "audio_extracted", "transcribing", "diarizing", "summarizing", "indexing"].includes(m.status)).length, "bg-[var(--primary)]/10 text-[var(--primary)]"],
                    ["Failed", meetings.filter((m) => m.status === "failed").length, "bg-destructive/10 text-destructive"],
                    ["Scheduled", meetings.filter((m) => m.status === "scheduled").length, "bg-[var(--muted)]/50 text-muted-foreground"],
                  ] as const
                ).map(([label, count, classes]) => (
                  <div
                    key={label}
                    className={`rounded-lg border border-[var(--divider)] p-3 ${classes}`}
                  >
                    <div className="text-xl font-semibold">{count}</div>
                    <div className="text-xs">{label}</div>
                  </div>
                ))}
              </div>
              {(() => {
                const failedJobs = jobs.filter((j) => j.status === "failed" && j.retryable !== false)
                return failedJobs.length > 0 ? (
                  <button
                    className="mt-2 rounded-lg bg-destructive/10 px-4 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/20"
                    onClick={() => {
                      // Retry the most recent failed job per meeting
                      const seen = new Set<string>()
                      for (const job of failedJobs) {
                        const key = job.meetingId ?? job.id
                        if (seen.has(key)) continue
                        seen.add(key)
                        onRetryJob(job)
                      }
                    }}
                    type="button"
                  >
                    Retry all failed ({failedJobs.length})
                  </button>
                ) : null
              })()}
            </section>
          </div>
          <div className="xl:col-span-2">
            <JobActivityCenter
              jobs={jobs}
              meetings={meetings}
              onRetry={onRetryJob}
              onOpenMeeting={onOpenMeeting}
            />
          </div>
        </div>
      </PageFrame>
    )
  }

  if (panel === "memory") {
    const completedCount = meetings.filter((meeting) => meeting.summary?.overview).length

    return (
      <PageFrame
        eyebrow="Cross-meeting memory"
        title="Ask and search your meeting memory"
        description="Search summaries, transcripts, decisions, tags, rooms, and action items across imported meetings."
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <OpsCard
            icon={SearchIcon}
            title="Memory search"
            description="Type a person, project, topic, tag, or decision to narrow the meeting memory."
          >
            <Input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search summaries, transcripts, tags, and decisions"
              className="h-10"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select
                className="rounded-md border border-[var(--divider)] bg-[var(--surface-subtle)] px-2 py-1.5 text-xs text-foreground"
                value={filterRoom}
                onChange={(e) => setFilterRoom(e.target.value)}
              >
                <option value="">All rooms</option>
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>{room.name}</option>
                ))}
              </select>
              <input
                className="rounded-md border border-[var(--divider)] bg-[var(--surface-subtle)] px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground"
                placeholder="Filter by tag..."
                value={filterTag}
                onChange={(e) => setFilterTag(e.target.value)}
              />
              <input
                className="rounded-md border border-[var(--divider)] bg-[var(--surface-subtle)] px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground"
                placeholder="Filter by participant..."
                value={filterParticipant}
                onChange={(e) => setFilterParticipant(e.target.value)}
              />
              <select
                className="rounded-md border border-[var(--divider)] bg-[var(--surface-subtle)] px-2 py-1.5 text-xs text-foreground"
                value={filterLanguage}
                onChange={(e) => setFilterLanguage(e.target.value)}
              >
                <option value="">All languages</option>
                <option value="he">Hebrew</option>
                <option value="en">English</option>
                <option value="pt">Portuguese</option>
                <option value="es">Spanish</option>
                <option value="it">Italian</option>
              </select>
              {(filterRoom || filterTag || filterParticipant || filterLanguage) ? (
                <button
                  className="text-xs text-[var(--primary)] hover:underline"
                  onClick={() => { setFilterRoom(""); setFilterTag(""); setFilterParticipant(""); setFilterLanguage("") }}
                  type="button"
                >
                  Clear filters
                </button>
              ) : null}
            </div>
            <div className="mt-3 grid gap-2">
              {memoryResults.slice(0, 8).map((meeting) => (
                <div key={meeting.id} className="rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 truncate text-sm font-semibold text-foreground">{meeting.title}</div>
                    <span className="shrink-0 rounded-sm bg-[var(--selected)] px-2 py-0.5 text-[11px] text-[var(--primary)]">
                      {meeting.status}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">
                    {meeting.overview || meeting.transcriptMatches[0]?.text || "No summary yet."}
                  </p>
                  {meeting.matches?.length ? (
                    <div className="mt-2 grid gap-1.5">
                      {meeting.matches.slice(0, 3).map((match, index) => (
                        <div
                          className="rounded-md border border-[var(--divider)] bg-[var(--surface)] px-2 py-1.5 text-xs leading-5"
                          key={`${match.source}-${match.segmentId ?? match.actionItemId ?? index}`}
                        >
                          <div className="mb-0.5 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-[var(--primary)]">
                            <span>{formatMemorySource(match.source)}</span>
                            {formatMemoryTime(match.startMs) ? (
                              <span>{formatMemoryTime(match.startMs)}</span>
                            ) : null}
                          </div>
                          <div className="line-clamp-2 text-muted-foreground">
                            {match.text}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-1">
                    {meeting.matchCount ? (
                      <span className="rounded-sm bg-[var(--selected)] px-2 py-0.5 text-[11px] text-[var(--primary)]">
                        {meeting.matchCount} matches
                      </span>
                    ) : null}
                    {meeting.tags.slice(0, 4).map((tag) => (
                      <span key={tag} className="rounded-sm bg-[var(--surface)] px-2 py-0.5 text-[11px] text-muted-foreground">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              {!memoryResults.length ? (
                <div className="rounded-lg border border-dashed border-[var(--divider)] bg-[var(--surface-subtle)] p-4 text-sm text-muted-foreground">
                  No indexed meeting memory matched this search.
                </div>
              ) : null}
            </div>
          </OpsCard>
          <OpsCard
            icon={SparklesIcon}
            title="Ask all meetings"
            description="Ask across indexed summaries and transcripts. Answers include server-side citations when available."
            status={`${completedCount} indexed`}
          >
            <div className="grid gap-2">
              <Input
                className="h-10"
                value={memoryQuestion}
                onChange={(event) => setMemoryQuestion(event.target.value)}
                placeholder="What did we decide about RealizeOS?"
              />
              <Button onClick={askMemory}>Ask memory</Button>
              {memoryAnswer ? (
                <div className="rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-3 text-sm leading-6">
                  <div className="whitespace-pre-wrap">{memoryAnswer}</div>
                  {memoryCitations.length ? (
                    <div className="mt-3 grid gap-2 border-t border-[var(--divider)] pt-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Citations
                      </div>
                      {memoryCitations.slice(0, 6).map((citation, index) => (
                        <div
                          className="rounded-md border border-[var(--divider)] bg-[var(--surface)] p-2 text-xs"
                          key={`${citation.meetingId}-${citation.source}-${citation.segmentId ?? citation.actionItemId ?? index}`}
                        >
                          <div className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                            <button
                              className="text-left text-[var(--primary)] hover:underline"
                              onClick={() => onOpenMeeting(citation.meetingId)}
                              type="button"
                            >
                              {citation.meetingTitle}
                            </button>
                            <Badge variant="outline" className="rounded-sm text-[10px]">
                              {formatMemorySource(citation.source)}
                            </Badge>
                            {formatMemoryTime(citation.startMs) ? (
                              <span className="text-muted-foreground">
                                {formatMemoryTime(citation.startMs)}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-1 line-clamp-2 text-muted-foreground">
                            {citation.text}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </OpsCard>
          <div className="lg:col-span-2">
            <OpsCard
              icon={LinkIcon}
              title="Rooms"
              description="Rooms group meetings, tasks, context, and future agent runs around recurring workstreams."
              status={`${rooms.length} rooms`}
            >
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {rooms.map((room) => (
                  <button
                    className="rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-3 text-left transition hover:border-[var(--primary)]/50 hover:bg-[var(--selected)]"
                    key={room.id}
                    onClick={() => openRoom(room.id)}
                    type="button"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 truncate text-sm font-semibold">{room.name}</div>
                      {selectedRoomId === room.id ? (
                        <Badge className="rounded-sm">open</Badge>
                      ) : null}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {room.meetingCount} linked meetings
                    </div>
                  </button>
                ))}
                {!rooms.length ? (
                  <div className="rounded-lg border border-dashed border-[var(--divider)] p-4 text-sm text-muted-foreground">
                    No rooms yet. Create one below to start grouping meetings.
                  </div>
                ) : null}
                <div className="col-span-full mt-1">
                  <div className="flex items-center gap-2">
                    <input
                      className="flex-1 rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-[var(--primary)] focus:outline-none"
                      placeholder="New room name..."
                      value={newRoomName}
                      onChange={(e) => setNewRoomName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void createRoom() }}
                    />
                    <button
                      className="rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] transition hover:opacity-90 disabled:opacity-50"
                      disabled={!newRoomName.trim() || roomCreating}
                      onClick={() => void createRoom()}
                      type="button"
                    >
                      {roomCreating ? "Creating..." : "Create Room"}
                    </button>
                  </div>
                </div>
              </div>
              {roomLoading ? (
                <div className="mt-4 rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-4 text-sm text-muted-foreground">
                  Loading room context...
                </div>
              ) : roomDetail ? (
                <div className="mt-4 grid gap-4">
                  <div className="rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-base font-semibold text-foreground">
                          {roomDetail.room.name}
                        </div>
                        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                          {roomDetail.room.description ??
                            "Room context built from linked meetings."}
                        </p>
                      </div>
                      <Badge variant="outline" className="rounded-md">
                        {roomDetail.stats.meetings} meetings
                      </Badge>
                    </div>
                    <div className="mt-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                      {[
                        ["Completed", roomDetail.stats.completedMeetings],
                        ["Processing", roomDetail.stats.processingMeetings],
                        ["Open tasks", roomDetail.stats.openTasks],
                        ["People", roomDetail.stats.participants],
                        ["Artifacts", roomDetail.stats.artifacts],
                        ["Meetings", roomDetail.stats.meetings],
                      ].map(([label, value]) => (
                        <div
                          className="rounded-md border border-[var(--divider)] bg-[var(--surface)] p-3"
                          key={label}
                        >
                          <div className="text-lg font-semibold">{value}</div>
                          <div className="text-[11px] text-muted-foreground">{label}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="grid gap-4 xl:grid-cols-3">
                    <div className="xl:col-span-2">
                      <div className="mb-2 text-sm font-semibold">Recent meetings</div>
                      <div className="grid gap-2">
                        {roomDetail.meetings.slice(0, 6).map((meeting) => (
                          <div
                            className="rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-3"
                            key={meeting.id}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0 truncate text-sm font-semibold">
                                {meeting.title}
                              </div>
                              <Badge variant="outline" className="rounded-sm">
                                {meeting.status}
                              </Badge>
                            </div>
                            <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                              {meeting.overview || "No summary yet."}
                            </p>
                            <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                              <span>{formatShortDate(meeting.startedAt)}</span>
                              <span>{meeting.openTasks} open tasks</span>
                              <span>{meeting.participants} people</span>
                              <span>{meeting.artifacts} artifacts</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="grid content-start gap-4">
                      <div>
                        <div className="mb-2 text-sm font-semibold">Open tasks</div>
                        <div className="grid gap-2">
                          {roomDetail.openTasks.slice(0, 5).map((task) => (
                            <div
                              className="rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-3 text-xs"
                              key={task.id}
                            >
                              <div className="font-medium text-foreground">{task.title}</div>
                              <div className="mt-1 text-muted-foreground">
                                {task.meetingTitle}
                                {task.owner ? ` · ${task.owner}` : ""}
                              </div>
                            </div>
                          ))}
                          {!roomDetail.openTasks.length ? (
                            <div className="rounded-lg border border-dashed border-[var(--divider)] p-3 text-xs text-muted-foreground">
                              No open tasks in this room.
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <div>
                        <div className="mb-2 text-sm font-semibold">People</div>
                        <div className="flex flex-wrap gap-1.5">
                          {roomDetail.participants.slice(0, 8).map((participant) => (
                            <span
                              className="rounded-sm bg-[var(--selected)] px-2 py-1 text-[11px] text-[var(--primary)]"
                              key={participant.email ?? participant.name}
                            >
                              {participant.name} · {participant.meetingCount}
                            </span>
                          ))}
                          {!roomDetail.participants.length ? (
                            <span className="text-xs text-muted-foreground">
                              No participants linked yet.
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </OpsCard>
          </div>
        </div>
      </PageFrame>
    )
  }

  if (panel === "automations") {
    return (
      <PageFrame
        eyebrow="External systems"
        title="Automations and integrations"
        description="Webhook, n8n, RealizeOS, CLI, and MCP connections should all consume the same structured meeting intelligence."
      >
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
          <OpsCard
            icon={WorkflowIcon}
            title="Webhook subscriptions"
            description="Create signed outbound webhooks for completed meetings, summaries, and action items."
            status={webhookLoading ? "syncing" : `${webhookSubscriptions.length} active`}
          >
            <div className="grid gap-3">
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
                <Input
                  className="h-10"
                  value={webhookUrl}
                  onChange={(event) => setWebhookUrl(event.target.value)}
                  placeholder="https://your-n8n-or-system.example/webhook/meetsum"
                />
                <Button
                  className="h-10"
                  disabled={webhookLoading}
                  onClick={createWebhookSubscription}
                >
                  <SendIcon data-icon="inline-start" className="size-4" />
                  Add webhook
                </Button>
              </div>
              <Button
                variant="outline"
                className="h-9 w-fit"
                disabled={webhookLoading || !webhookUrl.trim()}
                onClick={() => sendWebhookTest()}
              >
                Send test payload to URL
              </Button>
              <div className="flex flex-wrap gap-2">
                {webhookEvents.map((event) => (
                  <label
                    key={event.value}
                    className="flex h-8 cursor-pointer items-center gap-2 rounded-md border border-[var(--divider)] bg-[var(--surface-subtle)] px-2.5 text-xs font-medium text-foreground"
                  >
                    <input
                      type="checkbox"
                      className="size-3.5 accent-[var(--primary)]"
                      checked={webhookEventSelection.includes(event.value)}
                      onChange={() => toggleWebhookEvent(event.value)}
                    />
                    {event.label}
                  </label>
                ))}
              </div>
              <div className="grid gap-2">
                {webhookSubscriptions.map((subscription) => (
                  <div
                    key={subscription.id}
                    className="rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-3"
                  >
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="truncate font-mono text-xs text-foreground">
                          {subscription.url}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {subscription.events.map((event) => (
                            <span
                              key={event}
                              className="rounded-sm bg-[var(--selected)] px-2 py-0.5 text-[11px] font-medium text-[var(--primary)]"
                            >
                              {event}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge
                          className={
                            subscription.enabled
                              ? "rounded-md bg-[var(--selected)] text-[var(--primary)]"
                              : "rounded-md bg-[var(--surface)] text-muted-foreground"
                          }
                        >
                          {subscription.enabled ? "enabled" : "paused"}
                        </Badge>
                        <Button
                          className="h-8"
                          variant="outline"
                          disabled={webhookLoading}
                          onClick={() => setWebhookEnabled(subscription)}
                        >
                          {subscription.enabled ? "Pause" : "Enable"}
                        </Button>
                        <Button
                          className="h-8"
                          variant="outline"
                          disabled={webhookLoading || !subscription.enabled}
                          onClick={() => sendWebhookTest(subscription)}
                        >
                          Test
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
                {!webhookSubscriptions.length ? (
                  <div className="rounded-lg border border-dashed border-[var(--divider)] bg-[var(--surface-subtle)] p-4 text-sm text-muted-foreground">
                    No webhook subscriptions yet. Add your n8n webhook URL or
                    another API endpoint to start receiving signed MeetSum
                    events.
                  </div>
                ) : null}
              </div>
            </div>
          </OpsCard>

          <div className="grid gap-4">
            <OpsCard
              icon={BotIcon}
              title="RealizeOS"
              description="Structured meeting context exports with auditable retryable jobs."
              status={realizeOSStatus?.configured ? "configured" : "needs setup"}
            >
              <div className="grid gap-2">
                <div className="rounded-md border border-[var(--divider)] bg-[var(--surface-subtle)] p-3 text-sm">
                  <div className="font-medium text-foreground">
                    {realizeOSStatus?.configured
                      ? `${realizeOSStatus.baseUrl}${realizeOSStatus.path}`
                      : "REALIZEOS_API_URL missing"}
                  </div>
                  <p className="mt-1 leading-5 text-muted-foreground">
                    {realizeOSStatus?.message ??
                      "RealizeOS status will appear after the integration status endpoint loads."}
                  </p>
                </div>
                <Button
                  variant="outline"
                  className="h-9 w-full justify-start"
                  onClick={() => toast.info("Open a processed meeting and use RealizeOS export from the right rail. Export history appears here.")}
                >
                  View export flow
                </Button>
                <Button
                  variant="outline"
                  className="h-9 w-full justify-start"
                  onClick={() => copyAutomationText("meeting, summary, transcript references, action items, tags, language metadata, Google context", "RealizeOS payload fields")}
                >
                  Copy payload fields
                </Button>
                <div className="grid gap-2 pt-1">
                  {realizeOSExports.map((run) => (
                    <div
                      key={run.id}
                      className="rounded-md border border-[var(--divider)] bg-[var(--surface-subtle)] p-2.5 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-muted-foreground">
                          {run.meetingId}
                        </span>
                        <Badge
                          className={
                            run.status === "sent"
                              ? "rounded-md bg-[var(--selected)] text-[var(--primary)]"
                              : run.status === "failed"
                                ? "rounded-md bg-destructive/10 text-destructive"
                                : "rounded-md bg-[var(--surface)] text-muted-foreground"
                          }
                        >
                          {run.status}
                        </Badge>
                      </div>
                      {run.lastError ? (
                        <div className="mt-2 rounded-sm bg-destructive/10 px-2 py-1 text-destructive">
                          {run.lastError}
                        </div>
                      ) : null}
                      {run.response && Object.keys(run.response).length > 0 ? (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-[11px] font-medium text-[var(--primary)] hover:underline">
                            Response payload
                          </summary>
                          <pre className="mt-1.5 max-h-40 overflow-auto rounded-md border border-[var(--divider)] bg-[var(--surface)] p-2 font-mono text-[11px] leading-4 text-muted-foreground">
                            {JSON.stringify(run.response, null, 2)}
                          </pre>
                        </details>
                      ) : null}
                      <div className="mt-2 flex gap-2">
                        <Button
                          variant="outline"
                          className="h-7"
                          disabled={webhookLoading || !realizeOSStatus?.configured}
                          onClick={() => retryRealizeOSExport(run)}
                        >
                          Retry export
                        </Button>
                        {run.response ? (
                          <Button
                            variant="outline"
                            className="h-7"
                            onClick={() =>
                              copyAutomationText(
                                JSON.stringify(run.response, null, 2),
                                "RealizeOS response"
                              )
                            }
                          >
                            Copy response
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                  {!realizeOSExports.length ? (
                    <div className="rounded-md border border-dashed border-[var(--divider)] bg-[var(--surface-subtle)] p-3 text-xs text-muted-foreground">
                      No RealizeOS exports yet. Export a processed meeting to create the first auditable run.
                    </div>
                  ) : null}
                </div>
              </div>
            </OpsCard>
            <OpsCard
              icon={LinkIcon}
              title="n8n"
              description="Paste a production n8n webhook URL above. MeetSum will sign each event with x-meetsum-signature."
              status="prepared"
            >
              <div className="grid gap-2">
                <Button
                  variant="outline"
                  className="h-9 w-full justify-start"
                  onClick={() => copyAutomationText("x-meetsum-signature", "Webhook signature header")}
                >
                  Copy signature header
                </Button>
                <Button
                  variant="outline"
                  className="h-9 w-full justify-start"
                  onClick={() => copyAutomationText(webhookEvents.map((event) => event.value).join(", "), "n8n event list")}
                >
                  Copy event names
                </Button>
              </div>
            </OpsCard>
          </div>

          <OpsCard
            icon={CloudIcon}
            title="Delivery history"
            description="Recent webhook attempts with status, response code, and retry clues."
            status={`${webhookDeliveries.length} recent`}
          >
            <div className="grid gap-2">
              <Button
                variant="outline"
                className="h-8 w-fit"
                disabled={webhookLoading}
                onClick={refreshAutomations}
              >
                Refresh history
              </Button>
              {webhookDeliveries.map((delivery) => (
                <div
                  key={delivery.id}
                  className="rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-foreground">
                      {delivery.eventName}
                    </div>
                    <Badge
                      className={
                        delivery.status === "sent"
                          ? "rounded-md bg-[var(--selected)] text-[var(--primary)]"
                          : delivery.status === "failed"
                            ? "rounded-md bg-destructive/10 text-destructive"
                            : "rounded-md bg-[var(--selected)] text-[var(--primary)]"
                      }
                    >
                      {delivery.status}
                      {delivery.responseStatus ? ` ${delivery.responseStatus}` : ""}
                    </Badge>
                  </div>
                  <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                    {delivery.subscriptionUrl}
                  </div>
                  {delivery.lastError ? (
                    <div className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
                      {delivery.lastError}
                    </div>
                  ) : null}
                  {delivery.responseBody ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] font-medium text-[var(--primary)] hover:underline">
                        Response body
                      </summary>
                      <pre className="mt-1.5 max-h-32 overflow-auto rounded-md border border-[var(--divider)] bg-[var(--surface)] p-2 font-mono text-[11px] leading-4 text-muted-foreground">
                        {delivery.responseBody}
                      </pre>
                    </details>
                  ) : null}
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      Attempts: {delivery.attempts}
                    </span>
                    <Button
                      variant="outline"
                      className="h-7"
                      disabled={webhookLoading || delivery.status !== "failed"}
                      onClick={() => retryWebhookDelivery(delivery)}
                    >
                      Retry
                    </Button>
                  </div>
                </div>
              ))}
              {!webhookDeliveries.length ? (
                <div className="rounded-lg border border-dashed border-[var(--divider)] bg-[var(--surface-subtle)] p-4 text-sm text-muted-foreground">
                  Delivery attempts will appear after a subscribed event fires.
                </div>
              ) : null}
            </div>
          </OpsCard>

          <div className="xl:col-span-2">
            <JobRecoveryPanel
              jobs={jobs}
              meetings={meetings}
              onRetry={onRetryJob}
              onOpenMeeting={onOpenMeeting}
            />
          </div>
          <div className="xl:col-span-2">
            <JobActivityCenter jobs={jobs} onRetry={onRetryJob} />
          </div>
        </div>
      </PageFrame>
    )
  }

  if (panel === "storage") {
    const retainedBytes = mediaAssets.reduce(
      (sum, asset) => sum + asset.sizeBytes,
      0
    )

    return (
      <PageFrame
        eyebrow="Retention and backups"
        title="Storage operations"
        description="Audio is retained for 180 days by default, transcripts and summaries are retained indefinitely, and raw video is not kept unless explicitly enabled."
      >
        <div className="grid gap-4 lg:grid-cols-3">
          <OpsCard
            icon={DatabaseIcon}
            title="Media assets"
            description="Imported audio/video-derived assets stored privately in MinIO."
            status={`${mediaAssets.length} assets`}
          >
            <div className="text-sm text-muted-foreground">
              {formatBytes(retainedBytes)} currently tracked by MeetSum.
            </div>
          </OpsCard>
          <OpsCard
            icon={ShieldCheckIcon}
            title="Retention policy"
            description="Audio-first by default. Video retained only when configured."
            status="active"
          >
            <div className="grid gap-2 text-sm text-muted-foreground">
              <p>Audio: 180 days by default.</p>
              <p>Transcripts and summaries: retained indefinitely.</p>
              <p>Raw video: delete or avoid retaining unless explicitly needed.</p>
            </div>
          </OpsCard>
          <OpsCard
            icon={CloudIcon}
            title="Backups"
            description="Postgres backup runs before VPS deploys; restore remains operator-confirmed."
            status="configured"
          >
            <Button
              variant="outline"
              className="h-9 w-full justify-start"
              onClick={() => toast.info("Backups are created by the VPS deploy script before container replacement.")}
            >
              View backup policy
            </Button>
          </OpsCard>
          <div className="lg:col-span-3">
            <OpsCard
              icon={FileAudioIcon}
              title="Recent stored media"
              description="Delete selected audio/video assets without removing transcripts, summaries, tasks, or meeting metadata."
              status={storageLoading ? "loading" : `${mediaAssets.length} listed`}
            >
              <div className="mb-3 flex justify-end">
                <Button
                  variant="outline"
                  className="h-8"
                  disabled={storageLoading}
                  onClick={refreshStorage}
                >
                  Refresh assets
                </Button>
              </div>
              <div className="grid gap-2">
                {mediaAssets.map((asset) => (
                  <div
                    key={asset.id}
                    className="rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-3"
                  >
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-foreground">
                          {asset.filename ?? asset.meetingTitle}
                        </div>
                        <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                          {asset.meetingTitle}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          <span className="rounded-sm bg-[var(--selected)] px-2 py-0.5 text-[11px] font-medium text-[var(--primary)]">
                            {asset.retention}
                          </span>
                          <span className="rounded-sm bg-[var(--surface)] px-2 py-0.5 text-[11px] text-muted-foreground">
                            {asset.contentType}
                          </span>
                          <span className="rounded-sm bg-[var(--surface)] px-2 py-0.5 text-[11px] text-muted-foreground">
                            {formatBytes(asset.sizeBytes)}
                          </span>
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        className="h-8 shrink-0 text-destructive hover:text-destructive"
                        disabled={storageLoading}
                        onClick={() => deleteStoredMedia(asset)}
                      >
                        <Trash2Icon data-icon="inline-start" className="size-4" />
                        Delete media
                      </Button>
                    </div>
                  </div>
                ))}
                {!mediaAssets.length ? (
                  <div className="rounded-lg border border-dashed border-[var(--divider)] bg-[var(--surface-subtle)] p-4 text-sm text-muted-foreground">
                    No stored media assets were found. Imported recordings and
                    uploads will appear here after processing starts.
                  </div>
                ) : null}
              </div>
            </OpsCard>
          </div>
        </div>
      </PageFrame>
    )
  }

  if (panel === "manual") {
    return (
      <PageFrame
        eyebrow="System manual"
        title="MeetSum operating guide"
        description="A practical guide to how MeetSum captures meetings, processes intelligence, stores data, and connects to your business systems."
      >
        <div className="grid gap-4 lg:grid-cols-3">
          <OpsCard
            icon={BookOpenIcon}
            title="Basic logic"
            description="MeetSum turns calendar context and selected recordings into searchable meeting intelligence."
            status="V0.1"
          >
            <ol className="grid list-decimal gap-2 ps-5 text-sm leading-6 text-muted-foreground">
              <li>Calendar sync creates scheduled meeting records and participant context.</li>
              <li>Drive picker imports only the recordings you select.</li>
              <li>The worker extracts audio, transcribes, summarizes, indexes, and emits automation events.</li>
              <li>The UI shows summary, transcript, tasks, tags, participants, sharing, exports, and memory search.</li>
            </ol>
          </OpsCard>
          <OpsCard
            icon={RadioTowerIcon}
            title="Capture model"
            description="Online meetings use Google artifacts first. In-person meetings use upload or the browser recorder."
            status="audio-first"
          >
            <div className="grid gap-2 text-sm leading-6 text-muted-foreground">
              <p>For Google Meet, enable native recording/transcript/smart notes, then import artifacts after the meeting.</p>
              <p>For Zoom, Teams, or in-person sessions, upload the recording or use the PWA recorder.</p>
              <p>MeetSum does not join meetings as a bot in V0.1.0.</p>
            </div>
          </OpsCard>
          <OpsCard
            icon={WorkflowIcon}
            title="Automation surfaces"
            description="Every processed artifact is designed to flow into APIs, webhooks, RealizeOS, n8n, CLI, and MCP."
            status="connected"
          >
            <div className="grid gap-2 text-sm leading-6 text-muted-foreground">
              <p>Use RealizeOS export from the meeting right rail.</p>
              <p>Use webhooks for meeting.completed, summary.created, and action_item.created.</p>
              <p>Use CLI/MCP for agents and context-aware workflows once API keys are configured.</p>
            </div>
          </OpsCard>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <ManualBlock
            title="Daily workflow"
            items={[
              "Start in Meetings. Use Smart sort with 5 items per page for the most useful current meetings.",
              "Use Sync Calendar for schedule context, then Find Drive recordings to import specific recordings.",
              "Open a processed meeting, review Summary and Tasks, then use Transcript to search and map speakers.",
              "Share creates a public read-only transcript/summary page. Audio remains private by default.",
              "Use AI Memory to search or ask across all indexed summaries and transcripts.",
            ]}
          />
          <ManualBlock
            title="Meeting intelligence outputs"
            items={[
              "Overview: concise narrative summary of what happened and why it matters.",
              "Decisions: concrete decisions with evidence where available.",
              "Action items: task title, owner, due date, priority, confidence, and source quote when detected.",
              "Risks and open questions: blockers, uncertainty, missing owners, and unresolved decisions.",
              "Key quotes: timestamped transcript snippets used for evidence and follow-up.",
            ]}
          />
          <ManualBlock
            title="Data and retention"
            items={[
              "Postgres is the system of record for meetings, sync state, participants, summaries, actions, shares, jobs, and integrations.",
              "MinIO stores private media assets. Video is converted to audio-first assets by default.",
              "Redis/BullMQ handles processing jobs and retries.",
              "Default retention: transcripts and summaries indefinitely, audio 180 days, video only when explicitly enabled.",
              "Every deploy runs a Postgres backup before replacing disposable app/worker containers.",
            ]}
          />
          <ManualBlock
            title="Current limitations and next upgrades"
            items={[
              "Google Meet artifact listing works, but deeper artifact-to-meeting import/linking still needs expansion.",
              "Gmail context is connected conceptually but should remain secondary until Calendar and Drive are fully reliable.",
              "Notion and DOCX exports are prepared but not active; PDF and Markdown are first-class.",
              "Vertex AI is prepared as the stable credential path, but production still uses the AI Studio Gemini key until smoke-tested.",
              "Visible meeting bot/desktop recorder is deferred until consent and Meet Media API requirements are proven.",
            ]}
          />
        </div>
      </PageFrame>
    )
  }

  return (
    <PageFrame
      eyebrow="Product configuration"
      title="Settings"
      description="Configure identity, language, AI provider mode, security, and the live capture model."
    >
      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <nav className="ms-card grid content-start gap-1 p-2 text-sm">
          {[
            "Recording & Privacy",
            "AI settings",
            "Live meeting",
            "Developer/API",
            "Language",
            "Account/Security",
          ].map((item, index) => (
            <button
              key={item}
              type="button"
              onClick={() => setSettingsSection(item)}
              className={
                settingsSection === item || (!settingsSection && index === 0)
                  ? "rounded-lg bg-[var(--selected)] px-3 py-2 text-left font-semibold text-[var(--primary)] rtl:text-right"
                  : "rounded-lg px-3 py-2 text-left text-muted-foreground hover:bg-[var(--surface-subtle)] hover:text-foreground rtl:text-right"
              }
            >
              {item}
            </button>
          ))}
        </nav>
        <div className="grid gap-4">
          {settingsSection === "Recording & Privacy" ? (
            <OpsCard
              icon={RadioTowerIcon}
              title="Recording & Privacy"
              description="Set the default capture and retention behavior. These are product preferences; the worker still enforces safe media handling."
              status={settingsLoading ? "saving" : "saved"}
            >
              <div className="grid gap-3">
                <SettingRow
                  title="Google artifacts first"
                  description="Use native Meet recordings, transcripts, and smart notes as the preferred online capture path."
                >
                  <Switch
                    checked={settings.googleArtifactsFirst}
                    disabled={settingsLoading}
                    onCheckedChange={(checked) =>
                      saveSettingsPatch({ googleArtifactsFirst: Boolean(checked) })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="PWA recorder enabled"
                  description="Keep the browser recorder available for in-person meetings and non-Google calls."
                >
                  <Switch
                    checked={settings.pwaRecorderEnabled}
                    disabled={settingsLoading}
                    onCheckedChange={(checked) =>
                      saveSettingsPatch({ pwaRecorderEnabled: Boolean(checked) })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Auto-process imported media"
                  description="Queue transcription and intelligence immediately after manual upload or selected Drive import."
                >
                  <Switch
                    checked={settings.autoProcessImportedMedia}
                    disabled={settingsLoading}
                    onCheckedChange={(checked) =>
                      saveSettingsPatch({ autoProcessImportedMedia: Boolean(checked) })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Retain video by default"
                  description="Recommended off. MeetSum should stay audio-first unless you explicitly need video archives."
                >
                  <Switch
                    checked={settings.retainVideoByDefault}
                    disabled={settingsLoading}
                    onCheckedChange={(checked) =>
                      saveSettingsPatch({ retainVideoByDefault: Boolean(checked) })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Audio retention days"
                  description="Default is 180 days. Transcripts and summaries remain indefinitely unless later changed."
                >
                  <Input
                    className="h-9 w-24"
                    type="number"
                    min={1}
                    max={3650}
                    value={settings.audioRetentionDays}
                    disabled={settingsLoading}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        audioRetentionDays: Number(event.target.value),
                      })
                    }
                    onBlur={() =>
                      saveSettingsPatch({
                        audioRetentionDays: settings.audioRetentionDays,
                      })
                    }
                  />
                </SettingRow>
              </div>
            </OpsCard>
          ) : null}
          {settingsSection === "AI settings" ? (
            <OpsCard
              icon={SparklesIcon}
              title="AI settings"
              description="Choose preferred intelligence behavior. Active provider still depends on production secrets and environment validation."
              status={providers.find((provider) => provider.id === "gemini")?.mode ?? "Gemini"}
            >
              <div className="grid gap-3">
                <SettingRow
                  title="Preferred provider path"
                  description="AI Studio is active today. Vertex can be selected as a preference, but production switches only after credential smoke test."
                >
                  <NativeSelect
                    value={settings.aiProviderPreference}
                    disabled={settingsLoading}
                    onChange={(event) =>
                      saveSettingsPatch({
                        aiProviderPreference: event.target
                          .value as AppSettingsView["aiProviderPreference"],
                      })
                    }
                  >
                    <NativeSelectOption value="gemini-developer-api">
                      Gemini API key
                    </NativeSelectOption>
                    <NativeSelectOption value="vertex-ai">
                      Vertex AI
                    </NativeSelectOption>
                  </NativeSelect>
                </SettingRow>
                <SettingRow
                  title="Default summary template"
                  description="Used as the default intelligence style for future reprocess and summary runs."
                >
                  <NativeSelect
                    value={settings.summaryTemplate}
                    disabled={settingsLoading}
                    onChange={(event) =>
                      saveSettingsPatch({
                        summaryTemplate: event.target
                          .value as AppSettingsView["summaryTemplate"],
                      })
                    }
                  >
                    {["general", "sales", "real-estate", "product", "operations", "legal"].map((template) => (
                      <NativeSelectOption key={template} value={template}>
                        {template}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </SettingRow>
                <div className="grid gap-2 rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-3">
                  {providers.map((provider) => (
                    <div
                      key={provider.id}
                      className="flex flex-wrap items-center justify-between gap-2 text-sm"
                    >
                      <span className="font-medium text-foreground">{provider.label}</span>
                      <span className="text-muted-foreground">{provider.detail}</span>
                    </div>
                  ))}
                </div>
              </div>
            </OpsCard>
          ) : null}
          {settingsSection === "Live meeting" ? (
            <OpsCard
              icon={RadioTowerIcon}
              title="Live meeting capture"
              description="V0.1.0 stays Google-artifacts-first. Bot capture remains deferred until consent and Meet Media API constraints are proven."
              status="Google first"
            >
              <div className="grid gap-3">
                <SettingRow
                  title="Online meeting capture"
                  description="MeetSum imports native recordings/transcripts after meetings instead of joining as a bot."
                >
                  <Badge className="rounded-md bg-[var(--selected)] text-[var(--primary)]">
                    artifacts first
                  </Badge>
                </SettingRow>
                <SettingRow
                  title="Meeting content language"
                  description="Autodetect is recommended for mixed Hebrew/English/Portuguese/Spanish/Italian calls."
                >
                  <NativeSelect
                    value={settings.meetingLanguageMode}
                    disabled={settingsLoading}
                    onChange={(event) =>
                      saveSettingsPatch({
                        meetingLanguageMode: event.target
                          .value as AppSettingsView["meetingLanguageMode"],
                      })
                    }
                  >
                    <NativeSelectOption value="auto">Auto-detect</NativeSelectOption>
                    {SUPPORTED_LOCALES.map((locale) => (
                      <NativeSelectOption key={locale} value={locale}>
                        {localeLabels[locale]}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </SettingRow>
              </div>
            </OpsCard>
          ) : null}
          {settingsSection === "Developer/API" ? (
            <OpsCard
              icon={KeyRoundIcon}
              title="Developer/API"
              description="Machine integrations should use API keys, signed webhooks, CLI, and MCP. Secrets remain configured on the VPS."
              status="hardened"
            >
              <div className="grid gap-3">
                <SettingRow
                  title="Require API keys for machines"
                  description="Keep enabled for CLI, MCP, webhook management scripts, and external API clients."
                >
                  <Switch
                    checked={settings.requireApiKeyForMachines}
                    disabled={settingsLoading}
                    onCheckedChange={(checked) =>
                      saveSettingsPatch({ requireApiKeyForMachines: Boolean(checked) })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Webhook signing"
                  description="Outbound events use x-meetsum-signature. The signing secret is stored only in production env."
                >
                  <Badge className="rounded-md bg-[var(--selected)] text-[var(--primary)]">
                    enabled
                  </Badge>
                </SettingRow>
                <SettingRow
                  title="MCP and CLI"
                  description="Use server-side APIs and API keys for automation, not browser session cookies."
                >
                  <Button
                    variant="outline"
                    className="h-8"
                    onClick={() => copyAutomationText("MEETSUM_API_KEY", "API key env name")}
                  >
                    Copy env name
                  </Button>
                </SettingRow>
              </div>
            </OpsCard>
          ) : null}
          {settingsSection === "Language" ? (
            <OpsCard
              icon={BookOpenIcon}
              title="Language"
              description="UI language and meeting content language are separate. Hebrew remains RTL; mixed meeting content is detected by the intelligence layer."
              status={settings.defaultLocale.toUpperCase()}
            >
              <div className="grid gap-3">
                <SettingRow
                  title="Default UI locale"
                  description="Updates the saved locale cookie and app default preference."
                >
                  <NativeSelect
                    value={settings.defaultLocale}
                    disabled={settingsLoading}
                    onChange={(event) =>
                      saveSettingsPatch({
                        defaultLocale: event.target.value as SupportedLocale,
                      })
                    }
                  >
                    {SUPPORTED_LOCALES.map((locale) => (
                      <NativeSelectOption key={locale} value={locale}>
                        {localeLabels[locale]}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </SettingRow>
                <SettingRow
                  title="Meeting language handling"
                  description="Controls the default metadata preference; transcript segments can still be mixed-language."
                >
                  <NativeSelect
                    value={settings.meetingLanguageMode}
                    disabled={settingsLoading}
                    onChange={(event) =>
                      saveSettingsPatch({
                        meetingLanguageMode: event.target
                          .value as AppSettingsView["meetingLanguageMode"],
                      })
                    }
                  >
                    <NativeSelectOption value="auto">Auto-detect</NativeSelectOption>
                    {SUPPORTED_LOCALES.map((locale) => (
                      <NativeSelectOption key={locale} value={locale}>
                        {localeLabels[locale]}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </SettingRow>
              </div>
            </OpsCard>
          ) : null}
          {settingsSection === "Account/Security" ? (
            <OpsCard
              icon={ShieldCheckIcon}
              title="Account and security"
              description="First-admin Google OAuth remains the browser access path. Sharing defaults apply to newly created share links."
              status="Google OAuth"
            >
              <div className="grid gap-3">
                <SettingRow
                  title="Primary admin"
                  description="Browser auth and Workspace consent are tied to the first admin account."
                >
                  <span className="font-mono text-xs text-muted-foreground">
                    info@realization.co.il
                  </span>
                </SettingRow>
                <SettingRow
                  title="Public sharing enabled"
                  description="Allows public read-only summary/transcript links. Audio remains private by default."
                >
                  <Switch
                    checked={settings.publicSharingEnabled}
                    disabled={settingsLoading}
                    onCheckedChange={(checked) =>
                      saveSettingsPatch({ publicSharingEnabled: Boolean(checked) })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Include transcript by default"
                  description="Default share-page section preference for future share links."
                >
                  <Switch
                    checked={settings.shareTranscriptByDefault}
                    disabled={settingsLoading}
                    onCheckedChange={(checked) =>
                      saveSettingsPatch({ shareTranscriptByDefault: Boolean(checked) })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Include action items by default"
                  description="Default share-page section preference for future share links."
                >
                  <Switch
                    checked={settings.shareActionsByDefault}
                    disabled={settingsLoading}
                    onCheckedChange={(checked) =>
                      saveSettingsPatch({ shareActionsByDefault: Boolean(checked) })
                    }
                  />
                </SettingRow>
              </div>
            </OpsCard>
          ) : null}
        </div>
      </div>
    </PageFrame>
  )
}
