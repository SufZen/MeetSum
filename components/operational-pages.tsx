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
  SendIcon,
  ShieldCheckIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react"
import type { ComponentType, ReactNode, SVGProps } from "react"
import { useEffect, useState } from "react"
import dynamic from "next/dynamic"
import { useParams } from "next/navigation"
import { toast } from "sonner"

import { JobActivityCenter } from "@/components/job-activity-center"
import { JobRecoveryPanel } from "@/components/job-recovery-panel"
import {
  ProviderHealthPanel,
  ProviderWarning,
  type ProviderStatusView,
} from "@/components/provider-health-panel"
import { CompactSearchBox } from "@/components/search/compact-search-box"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CitedMark } from "@/components/ui/meeting-atoms"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import { WorkspaceSyncPanel, type WorkspaceStatusView } from "@/components/workspace-sync-panel"
import type { MainPanelKey } from "@/components/main-sidebar"
import { useWorkspace } from "@/components/workspace-context"
import { apiErrorMessage } from "@/lib/i18n/api-errors"
import { dictionaries, type Dictionary } from "@/lib/i18n/dictionaries"
import { SUPPORTED_LOCALES, type SupportedLocale } from "@/lib/i18n/locales"
import type { JobRecord, MeetingRecord } from "@/lib/meetings/repository"

// Only Settings → Live meeting uses it; loaded when that section opens (M7).
const BotRulesSettings = dynamic(
  () => import("@/components/bot/bot-rules-settings").then((mod) => mod.BotRulesSettings),
  { loading: () => <div aria-busy="true" className="ms-card h-48 animate-pulse bg-surface-2" /> }
)
// Only the AI settings section uses it; loaded when that section opens.
const AsrGlossaryEditor = dynamic(
  () => import("@/components/asr-glossary-editor").then((mod) => mod.AsrGlossaryEditor),
  { loading: () => <div aria-busy="true" className="h-40 animate-pulse rounded-lg bg-surface-2" /> }
)
// M5: AI model settings and workspace summary templates (AI settings section).
const LlmSettings = dynamic(
  () => import("@/components/intelligence/llm-settings").then((mod) => mod.LlmSettings),
  { loading: () => <div aria-busy="true" className="h-40 animate-pulse rounded-lg bg-surface-2" /> }
)
const TemplatesSettings = dynamic(
  () => import("@/components/intelligence/template-editor").then((mod) => mod.TemplatesSettings),
  { loading: () => <div aria-busy="true" className="h-40 animate-pulse rounded-lg bg-surface-2" /> }
)

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
  maxAttempts?: number
  responseStatus?: number
  responseBody?: string
  lastError?: string
  deliveredAt?: string
  durationMs?: number
  createdAt: string
}

type RevealedWebhookSecret = {
  subscriptionId: string
  url: string
  secret: string
  reason: "created" | "rotated"
}

const WEBHOOK_RETRYABLE_STATUSES = new Set(["failed", "cancelled"])

function webhookDeliveryBadgeClass(status: string) {
  if (status === "sent") return "rounded-md bg-brand-soft text-brand-text"
  if (status === "failed") return "rounded-md bg-destructive/10 text-destructive"
  if (status === "retrying") return "rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-300"
  return "rounded-md bg-surface text-muted-foreground"
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
  summaryTemplate: "general" | "sales" | "real-estate" | "product" | "operations" | "legal"
  googleArtifactsFirst: boolean
  pwaRecorderEnabled: boolean
  autoProcessImportedMedia: boolean
  publicSharingEnabled: boolean
  shareTranscriptByDefault: boolean
  shareActionsByDefault: boolean
  audioRetentionDays: number
  retainVideoByDefault: boolean
  defaultMeetingVisibility: "workspace" | "private"
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
  summaryTemplate: "general",
  googleArtifactsFirst: true,
  pwaRecorderEnabled: true,
  autoProcessImportedMedia: true,
  publicSharingEnabled: true,
  shareTranscriptByDefault: true,
  shareActionsByDefault: true,
  audioRetentionDays: 180,
  retainVideoByDefault: false,
  defaultMeetingVisibility: "workspace",
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
    <div className="ms-scrollbar min-h-[calc(100svh-3.5rem)] overflow-y-auto bg-surface-2 p-3 lg:h-[calc(100svh-3.5rem)] lg:p-5">
      <div className="mx-auto grid max-w-7xl gap-4">
        <header className="flex flex-col gap-3 px-1 py-1 lg:flex-row lg:items-end lg:justify-between">
          <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-brand-text">
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
  icon: ComponentType<SVGProps<SVGSVGElement>>
  title: string
  description: string
  status?: string
  children?: ReactNode
}) {
  return (
    <section className="ms-card p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="grid size-8 place-items-center rounded-md bg-brand-soft text-brand-text">
            <Icon aria-hidden="true" className="size-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground">{title}</h2>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">{description}</p>
          </div>
        </div>
        {status && (
          <Badge className="rounded-md bg-brand-soft text-brand-text">{status}</Badge>
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
            className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm leading-6 text-muted-foreground"
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
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-3 sm:flex-row sm:items-center sm:justify-between">
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

type MeetingStatusTotals = {
  completed: number
  processing: number
  failed: number
  scheduled: number
}

async function fetchMeetingStatusTotals(): Promise<MeetingStatusTotals | undefined> {
  const statuses = ["completed", "processing", "failed", "scheduled"] as const

  try {
    const totals = await Promise.all(
      statuses.map(async (status) => {
        const response = await fetch(`/api/meetings?limit=5&status=${status}`)

        if (!response.ok) throw new Error(`Unable to count ${status} meetings`)

        const body = (await response.json()) as { page?: { total?: number } }

        return typeof body.page?.total === "number" ? body.page.total : 0
      })
    )

    return {
      completed: totals[0],
      processing: totals[1],
      failed: totals[2],
      scheduled: totals[3],
    }
  } catch {
    return undefined
  }
}

export function OperationalPage({
  panel,
  meetings,
  jobs,
  providers,
  workspaceStatus,
  syncing,
  query,
  onSyncCalendar,
  onFindDriveRecordings,
  onRetryJob,
  onOpenMeeting,
  onProcessMeeting,
  onSyncMeetArtifacts,
  dictionary = dictionaries.en,
}: {
  dictionary?: Dictionary
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
  const t = dictionary
  const { can } = useWorkspace()
  // M6: the memory panel is a compact entry into Search & Ask.
  const memoryLocale = useParams<{ locale?: string }>()?.locale ?? "en"
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
  const [revealedWebhookSecret, setRevealedWebhookSecret] =
    useState<RevealedWebhookSecret>()
  const [realizeOSStatus, setRealizeOSStatus] = useState<RealizeOSStatusView>()
  const [realizeOSExports, setRealizeOSExports] = useState<RealizeOSExportView[]>([])
  const [mediaAssets, setMediaAssets] = useState<MediaAssetView[]>([])
  const [storageLoading, setStorageLoading] = useState(false)
  const [settings, setSettings] = useState<AppSettingsView>(defaultSettings)
  const [settingsLoading, setSettingsLoading] = useState(false)
  // Settings are readable by every member; only admins may change them.
  const settingsReadOnly = !can("settings:write")
  const settingsDisabled = settingsLoading || settingsReadOnly
  const [settingsSection, setSettingsSection] = useState("Recording & Privacy")
  const [meetArtifacts, setMeetArtifacts] = useState<MeetArtifactStatusView>()
  const [meetArtifactsLoading, setMeetArtifactsLoading] = useState(false)
  const [meetArtifactsError, setMeetArtifactsError] = useState("")
  const [meetingTotals, setMeetingTotals] = useState<MeetingStatusTotals>()

  useEffect(() => {
    if (panel !== "memory") return

    void fetch("/api/rooms")
      .then((response) => response.json())
      .then((body) => setRooms(body.rooms ?? []))
      .catch(() => setRooms([]))
  }, [panel])

  useEffect(() => {
    if (panel !== "automations") return

    void refreshAutomations()
  }, [panel])

  useEffect(() => {
    if (panel !== "storage") return

    void refreshStorage()
    void refreshSettings()
  }, [panel])

  useEffect(() => {
    if (panel !== "workspace" && panel !== "memory") return

    let cancelled = false

    void fetchMeetingStatusTotals().then((totals) => {
      if (!cancelled && totals) setMeetingTotals(totals)
    })

    return () => {
      cancelled = true
    }
  }, [panel])

  useEffect(() => {
    if (panel !== "settings") return

    void refreshSettings()
  }, [panel])

  useEffect(() => {
    if (panel !== "workspace") return

    void refreshMeetArtifacts()
    // Reload only when the panel opens (the dictionary is read at call time).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel])

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
      if (body.secret && body.subscription) {
        setRevealedWebhookSecret({
          subscriptionId: body.subscription.id,
          url: body.subscription.url,
          secret: body.secret,
          reason: "created",
        })
      }
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

  async function rotateWebhookSecret(subscription: WebhookSubscriptionView) {
    const confirmed = window.confirm(
      "Rotate the signing secret? Receivers must switch to the new secret; deliveries signed with the old one will stop verifying."
    )

    if (!confirmed) return

    setWebhookLoading(true)
    try {
      const response = await fetch(`/api/webhooks/subscriptions/${subscription.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rotateSecret: true }),
      })
      const body = await response.json()

      if (!response.ok) {
        throw new Error(body.error ?? "Unable to rotate webhook secret")
      }

      setRevealedWebhookSecret({
        subscriptionId: subscription.id,
        url: subscription.url,
        secret: body.secret,
        reason: "rotated",
      })
      toast.success("Webhook secret rotated")
      await refreshAutomations()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to rotate webhook secret"
      )
    } finally {
      setWebhookLoading(false)
    }
  }

  async function deleteWebhookSubscription(subscription: WebhookSubscriptionView) {
    const confirmed = window.confirm(
      `Delete the webhook for ${subscription.url}? Its delivery history is deleted too.`
    )

    if (!confirmed) return

    setWebhookLoading(true)
    try {
      const response = await fetch(`/api/webhooks/subscriptions/${subscription.id}`, {
        method: "DELETE",
      })
      const body = await response.json()

      if (!response.ok) {
        throw new Error(body.error ?? "Unable to delete webhook subscription")
      }

      if (revealedWebhookSecret?.subscriptionId === subscription.id) {
        setRevealedWebhookSecret(undefined)
      }
      toast.success("Webhook subscription deleted")
      await refreshAutomations()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to delete subscription"
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

      toast.success("Webhook delivery queued for retry")
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
        throw new Error(
          apiErrorMessage(body, t, "Unable to load Meet artifact status")
        )
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
        throw new Error(apiErrorMessage(body, t, "Unable to sync Meet artifacts"))
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
              description="Native Google Meet recordings, transcripts, and smart notes are imported after the meeting. The MeetSum bot can also join and record online meetings."
              status={
                meetArtifacts?.setup?.authorized
                  ? "Artifacts authorized"
                  : "Google artifacts first"
              }
            >
              <div className="grid gap-2 text-sm text-muted-foreground">
                <div className="flex items-center justify-between rounded-lg border border-line bg-surface-2 p-3">
                  <span>Recording / transcript / smart notes readiness</span>
                  <Badge
                    variant="outline"
                    className={
                      meetArtifacts?.setup?.authorized
                        ? "rounded-md border-ok text-ok-text"
                        : "rounded-md"
                    }
                  >
                    {meetArtifacts?.setup?.authorized ? "authorized" : "checklist"}
                  </Badge>
                </div>
                {meetArtifacts?.setup?.message ? (
                  <div className="rounded-md border border-warn/40 bg-surface-2 px-3 py-2 text-xs leading-5 text-warn-text">
                    {meetArtifacts.setup.message}
                  </div>
                ) : null}
                {meetArtifactsError ? (
                  <div className="rounded-md border border-danger/40 bg-warn-soft px-3 py-2 text-xs leading-5 text-warn-text">
                    {meetArtifactsError}
                  </div>
                ) : null}
                {meetArtifacts ? (
                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded-md border border-line bg-surface-2 p-2">
                      <div className="text-xs text-muted-foreground">Live records</div>
                      <div className="mt-1 font-semibold text-foreground">
                        {meetArtifacts.conferenceRecords.length}
                      </div>
                    </div>
                    <div className="rounded-md border border-line bg-surface-2 p-2">
                      <div className="text-xs text-muted-foreground">Persisted</div>
                      <div className="mt-1 font-semibold text-foreground">
                        {meetArtifacts.persistedRecords.length}
                      </div>
                    </div>
                    <div className="rounded-md border border-line bg-surface-2 p-2">
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
                        className="rounded-md border border-line bg-surface-2 p-3"
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
                                className="rounded-sm bg-brand-soft px-2 py-0.5 text-2xs font-medium text-brand-text"
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
                    ["Completed", meetingTotals?.completed, "bg-ok/10 text-ok-text"],
                    ["Processing", meetingTotals?.processing, "bg-brand/10 text-brand-text"],
                    ["Failed", meetingTotals?.failed, "bg-destructive/10 text-destructive"],
                    ["Scheduled", meetingTotals?.scheduled, "bg-surface-2/50 text-muted-foreground"],
                  ] as const
                ).map(([label, count, classes]) => (
                  <div
                    key={label}
                    className={`rounded-lg border border-line p-3 ${classes}`}
                  >
                    <div className="text-xl font-semibold">{count ?? "—"}</div>
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

    return (
      <PageFrame
        eyebrow={t.navMemory}
        title={t.searchTitle}
        description={t.searchSubtitle}
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="lg:col-span-2">
            <CompactSearchBox locale={memoryLocale} dictionary={t} initialQuery={query} />
          </div>
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
                    className="rounded-lg border border-line bg-surface-2 p-3 text-start transition hover:border-brand/50 hover:bg-brand-soft"
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
                  <div className="rounded-lg border border-dashed border-line p-4 text-sm text-muted-foreground">
                    No rooms yet. Create one below to start grouping meetings.
                  </div>
                ) : null}
                <div className="col-span-full mt-1">
                  <div className="flex items-center gap-2">
                    <input
                      className="flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand focus:outline-none"
                      placeholder="New room name..."
                      value={newRoomName}
                      onChange={(e) => setNewRoomName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void createRoom() }}
                    />
                    <button
                      className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-on-brand transition hover:opacity-90 disabled:opacity-50"
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
                <div className="mt-4 rounded-lg border border-line bg-surface-2 p-4 text-sm text-muted-foreground">
                  Loading room context...
                </div>
              ) : roomDetail ? (
                <div className="mt-4 grid gap-4">
                  <div className="rounded-lg border border-line bg-surface-2 p-4">
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
                          className="rounded-md border border-line bg-surface p-3"
                          key={label}
                        >
                          <div className="text-lg font-semibold">{value}</div>
                          <div className="text-2xs text-muted-foreground">{label}</div>
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
                            className="rounded-lg border border-line bg-surface-2 p-3"
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
                            <div className="mt-2 flex flex-wrap gap-2 text-2xs text-muted-foreground">
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
                              className="rounded-lg border border-line bg-surface-2 p-3 text-xs"
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
                            <div className="rounded-lg border border-dashed border-line p-3 text-xs text-muted-foreground">
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
                              className="rounded-sm bg-brand-soft px-2 py-1 text-2xs text-brand-text"
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
                  <SendIcon data-icon="inline-start" data-directional="" className="size-4" />
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
                    className="flex h-8 cursor-pointer items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 text-xs font-medium text-foreground"
                  >
                    <input
                      type="checkbox"
                      className="size-3.5 accent-brand"
                      checked={webhookEventSelection.includes(event.value)}
                      onChange={() => toggleWebhookEvent(event.value)}
                    />
                    {event.label}
                  </label>
                ))}
              </div>
              {revealedWebhookSecret ? (
                <div className="rounded-lg border border-brand bg-brand-soft p-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <KeyRoundIcon className="size-4 text-brand-text" />
                    {revealedWebhookSecret.reason === "rotated"
                      ? "New signing secret"
                      : "Signing secret"}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Copy it now for {revealedWebhookSecret.url}. It is stored
                    encrypted and will not be shown again. Verify the
                    x-meetsum-signature header (HMAC-SHA256 of the body) with it.
                  </p>
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                    <code className="min-w-0 flex-1 break-all rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-xs text-foreground">
                      {revealedWebhookSecret.secret}
                    </code>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        className="h-8"
                        variant="outline"
                        onClick={() =>
                          copyAutomationText(revealedWebhookSecret.secret, "Signing secret")
                        }
                      >
                        Copy
                      </Button>
                      <Button
                        className="h-8"
                        variant="outline"
                        onClick={() => setRevealedWebhookSecret(undefined)}
                      >
                        Done
                      </Button>
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="grid gap-2">
                {webhookSubscriptions.map((subscription) => (
                  <div
                    key={subscription.id}
                    className="rounded-lg border border-line bg-surface-2 p-3"
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
                              className="rounded-sm bg-brand-soft px-2 py-0.5 text-2xs font-medium text-brand-text"
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
                              ? "rounded-md bg-brand-soft text-brand-text"
                              : "rounded-md bg-surface text-muted-foreground"
                          }
                        >
                          {subscription.enabled ? "enabled" : "paused"}
                        </Badge>
                        {subscription.secretRef === "global" ? (
                          <Badge
                            className="rounded-md bg-surface text-muted-foreground"
                            title="Signed with the shared WEBHOOK_SIGNING_SECRET. Rotate to give this webhook its own secret."
                          >
                            shared secret
                          </Badge>
                        ) : null}
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
                        <Button
                          className="h-8"
                          variant="outline"
                          disabled={webhookLoading}
                          onClick={() => rotateWebhookSecret(subscription)}
                          title="Rotate signing secret"
                        >
                          <KeyRoundIcon className="size-4" />
                          <span className="sr-only">Rotate signing secret</span>
                        </Button>
                        <Button
                          className="h-8"
                          variant="outline"
                          disabled={webhookLoading}
                          onClick={() => deleteWebhookSubscription(subscription)}
                          title="Delete webhook"
                        >
                          <Trash2Icon className="size-4" />
                          <span className="sr-only">Delete webhook</span>
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
                {!webhookSubscriptions.length ? (
                  <div className="rounded-lg border border-dashed border-line bg-surface-2 p-4 text-sm text-muted-foreground">
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
                <div className="rounded-md border border-line bg-surface-2 p-3 text-sm">
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
                      className="rounded-md border border-line bg-surface-2 p-2.5 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-muted-foreground">
                          {run.meetingId}
                        </span>
                        <Badge
                          className={
                            run.status === "sent"
                              ? "rounded-md bg-brand-soft text-brand-text"
                              : run.status === "failed"
                                ? "rounded-md bg-destructive/10 text-destructive"
                                : "rounded-md bg-surface text-muted-foreground"
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
                          <summary className="cursor-pointer text-2xs font-medium text-brand-text hover:underline">
                            Response payload
                          </summary>
                          <pre className="mt-1.5 max-h-40 overflow-auto rounded-md border border-line bg-surface p-2 font-mono text-2xs leading-4 text-muted-foreground">
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
                    <div className="rounded-md border border-dashed border-line bg-surface-2 p-3 text-xs text-muted-foreground">
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
                  className="rounded-lg border border-line bg-surface-2 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-foreground">
                      {delivery.eventName}
                    </div>
                    <Badge className={webhookDeliveryBadgeClass(delivery.status)}>
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
                      <summary className="cursor-pointer text-2xs font-medium text-brand-text hover:underline">
                        Response body
                      </summary>
                      <pre className="mt-1.5 max-h-32 overflow-auto rounded-md border border-line bg-surface p-2 font-mono text-2xs leading-4 text-muted-foreground">
                        {delivery.responseBody}
                      </pre>
                    </details>
                  ) : null}
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      Attempts: {delivery.attempts}
                      {delivery.maxAttempts ? ` (budget ${delivery.maxAttempts})` : ""}
                      {delivery.durationMs !== undefined ? ` · ${delivery.durationMs} ms` : ""}
                    </span>
                    <Button
                      variant="outline"
                      className="h-7"
                      disabled={
                        webhookLoading || !WEBHOOK_RETRYABLE_STATUSES.has(delivery.status)
                      }
                      onClick={() => retryWebhookDelivery(delivery)}
                    >
                      Retry
                    </Button>
                  </div>
                </div>
              ))}
              {!webhookDeliveries.length ? (
                <div className="rounded-lg border border-dashed border-line bg-surface-2 p-4 text-sm text-muted-foreground">
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
        description="Audio retention follows your settings, transcripts and summaries are retained indefinitely, and raw video is not kept unless explicitly enabled."
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
              <p>
                Audio:{" "}
                {settingsLoading
                  ? "loading…"
                  : `${settings.audioRetentionDays} days (from Settings).`}
              </p>
              <p>
                Video:{" "}
                {settingsLoading
                  ? "loading…"
                  : settings.retainVideoByDefault
                    ? "original video kept for Drive imports."
                    : "Drive imports stored as audio."}
              </p>
              <p>Transcripts and summaries: retained indefinitely.</p>
            </div>
          </OpsCard>
          <OpsCard
            icon={CloudIcon}
            title="Backups"
            description="Postgres backup runs before VPS deploys; restore remains operator-confirmed."
            status="configured"
          >
            <p className="text-sm text-muted-foreground">
              Backups are created by the VPS deploy script before container
              replacement. Restores are run by an operator.
            </p>
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
                    className="rounded-lg border border-line bg-surface-2 p-3"
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
                          <span className="rounded-sm bg-brand-soft px-2 py-0.5 text-2xs font-medium text-brand-text">
                            {asset.retention}
                          </span>
                          <span className="rounded-sm bg-surface px-2 py-0.5 text-2xs text-muted-foreground">
                            {asset.contentType}
                          </span>
                          <span className="rounded-sm bg-surface px-2 py-0.5 text-2xs text-muted-foreground">
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
                  <div className="rounded-lg border border-dashed border-line bg-surface-2 p-4 text-sm text-muted-foreground">
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
              <p>The MeetSum bot can join Meet, Zoom or Teams calls when sent from the Record menu or by auto-join rules.</p>
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
              "Packaged desktop-recorder release polish remains deferred until code-signing and installer requirements are proven; the local desktop companion and desktop imports are available through the repo, UI, and API.",
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
                  ? "rounded-lg bg-brand-soft px-3 py-2 text-start font-semibold text-brand-text"
                  : "rounded-lg px-3 py-2 text-start text-muted-foreground hover:bg-surface-2 hover:text-foreground"
              }
            >
              {item}
            </button>
          ))}
        </nav>
        <div className="grid gap-4">
          {settingsReadOnly ? (
            <div
              role="status"
              className="flex items-center gap-2 rounded-lg border border-line bg-surface p-3 text-sm text-muted-foreground"
            >
              <ShieldCheckIcon aria-hidden="true" className="size-4 shrink-0" />
              {t.settingsReadOnly}
            </div>
          ) : null}
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
                    disabled={settingsDisabled}
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
                    disabled={settingsDisabled}
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
                    disabled={settingsDisabled}
                    onCheckedChange={(checked) =>
                      saveSettingsPatch({ autoProcessImportedMedia: Boolean(checked) })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title={t.settingsKeepVideoTitle}
                  description={t.settingsKeepVideoDescription}
                >
                  <Switch
                    checked={settings.retainVideoByDefault}
                    disabled={settingsDisabled}
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
                    disabled={settingsDisabled}
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
              icon={CitedMark}
              title="AI settings"
              description="Choose preferred intelligence behavior. Active provider still depends on production secrets and environment validation."
              status={providers.find((provider) => provider.id === "gemini")?.mode ?? "Gemini"}
            >
              {/* The default summary template lives in LlmSettings below
                  (built-in and workspace templates); the legacy slug list
                  was a second, conflicting control. */}
              <div className="grid gap-3">
                <div className="grid gap-2 rounded-lg border border-line bg-surface-2 p-3">
                  {providers.map((provider) => (
                    <div key={provider.id} className="grid gap-1 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-foreground">{provider.label}</span>
                        <span className="text-muted-foreground">{provider.detail}</span>
                      </div>
                      <ProviderWarning warning={provider.warning} />
                    </div>
                  ))}
                </div>
              </div>
            </OpsCard>
          ) : null}
          {settingsSection === "AI settings" ? (
            <>
              <LlmSettings dictionary={t} locale={settings.defaultLocale} readOnly={settingsReadOnly} />
              <TemplatesSettings dictionary={t} locale={settings.defaultLocale} readOnly={settingsReadOnly} />
            </>
          ) : null}
          {settingsSection === "AI settings" ? <AsrGlossaryEditor dictionary={t} /> : null}
          {settingsSection === "Live meeting" ? (
            <OpsCard
              icon={RadioTowerIcon}
              title="Live meeting capture"
              description="Google Meet artifacts are imported after meetings. The MeetSum bot can join Meet, Zoom and Teams calls and record them (configure it below)."
              status="Google first"
            >
              <div className="grid gap-3">
                <SettingRow
                  title="Meeting content language"
                  description="Autodetect is recommended for mixed Hebrew/English/Portuguese/Spanish/Italian calls."
                >
                  <NativeSelect
                    value={settings.meetingLanguageMode}
                    disabled={settingsDisabled}
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
          {settingsSection === "Live meeting" ? <BotRulesSettings dictionary={t} /> : null}
          {settingsSection === "Developer/API" ? (
            <OpsCard
              icon={KeyRoundIcon}
              title="Developer/API"
              description="Machine integrations should use API keys, signed webhooks, CLI, and MCP. Secrets remain configured on the VPS."
              status="hardened"
            >
              <div className="grid gap-3">
                <SettingRow
                  title="Webhook signing"
                  description="Outbound events use x-meetsum-signature. The signing secret is stored only in production env."
                >
                  <Badge className="rounded-md bg-brand-soft text-brand-text">
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
                    disabled={settingsDisabled}
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
                    disabled={settingsDisabled}
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
                    {workspaceStatus
                      ? (workspaceStatus.google.subject ?? "Not configured")
                      : "Checking…"}
                  </span>
                </SettingRow>
                <SettingRow
                  title={t.settingsDefaultVisibilityTitle}
                  description={t.settingsDefaultVisibilityDescription}
                >
                  <NativeSelect
                    aria-label={t.settingsDefaultVisibilityTitle}
                    value={settings.defaultMeetingVisibility}
                    disabled={settingsDisabled}
                    onChange={(event) =>
                      saveSettingsPatch({
                        defaultMeetingVisibility: event.target
                          .value as AppSettingsView["defaultMeetingVisibility"],
                      })
                    }
                  >
                    <NativeSelectOption value="workspace">
                      {t.visibilityWorkspace}
                    </NativeSelectOption>
                    <NativeSelectOption value="private">
                      {t.visibilityPrivate}
                    </NativeSelectOption>
                  </NativeSelect>
                </SettingRow>
                <SettingRow
                  title="Public sharing enabled"
                  description="Allows public read-only summary/transcript links. Audio remains private by default."
                >
                  <Switch
                    checked={settings.publicSharingEnabled}
                    disabled={settingsDisabled}
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
                    disabled={settingsDisabled}
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
                    disabled={settingsDisabled}
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
