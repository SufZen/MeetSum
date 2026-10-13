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
  ShieldCheckIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react"
import type { ComponentType, ReactNode, SVGProps } from "react"
import { useEffect, useState } from "react"
import dynamic from "next/dynamic"
import { toast } from "sonner"

import { useI18n, type I18nValue } from "@/components/i18n-provider"
import { JobActivityCenter } from "@/components/job-activity-center"
import { NotificationPreferences } from "@/components/notifications/notification-preferences"
import { PersonalPreferences } from "@/components/settings/personal-preferences"
import { SettingsNav, useSettingsSection } from "@/components/settings/settings-nav"
import { JobRecoveryPanel } from "@/components/job-recovery-panel"
import {
  ProviderHealthPanel,
  ProviderWarning,
  type ProviderStatusView,
} from "@/components/provider-health-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { CitedMark } from "@/components/ui/meeting-atoms"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import { WorkspaceSyncPanel, type WorkspaceStatusView } from "@/components/workspace-sync-panel"
import type { MainPanelKey } from "@/components/main-sidebar"
import { useWorkspace } from "@/components/workspace-context"
import { buildShellUrl } from "@/lib/client/shell-url"
import { apiErrorText } from "@/lib/i18n/api-errors"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import { formatBytes } from "@/lib/i18n/format"
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from "@/lib/i18n/locales"
import { CONTENT_LANGUAGES, type ContentLanguage } from "@/lib/intelligence/types"
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
// M6: the memory panel's search box (and the search URL helpers) load with the panel.
const CompactSearchBox = dynamic(
  () => import("@/components/search/compact-search-box").then((mod) => mod.CompactSearchBox),
  { loading: () => <div aria-busy="true" className="h-10 animate-pulse rounded-md bg-surface-2" /> }
)
// M8: Settings → Integrations (Package D), loaded when that section opens.
const IntegrationsSettings = dynamic(
  () => import("@/components/integrations/integrations-settings").then((mod) => mod.IntegrationsSettings),
  { loading: () => <div aria-busy="true" className="ms-card h-48 animate-pulse bg-surface-2" /> }
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
  meetingLanguageMode: "auto" | ContentLanguage
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

/** Platform event names (technical identifiers, copied for n8n). */
const WEBHOOK_EVENT_NAMES = [
  "meeting.completed",
  "summary.created",
  "action_item.created",
  "meeting.process_failed",
  "realizeos.export.sent",
  "realizeos.export.failed",
] as const

/** Field list copied for RealizeOS integrators (technical, English by design). */
const REALIZEOS_PAYLOAD_FIELDS = "meeting, summary, transcript references, action items, tags, language metadata, Google context" // i18n-allow: technical payload field list copied to the clipboard

const LOCALE_LABEL_KEYS: Record<SupportedLocale, string> = {
  he: "settingsLanguageHebrew",
  en: "settingsLanguageEnglish",
}

const CONTENT_LANGUAGE_LABEL_KEYS: Record<ContentLanguage, string> = {
  en: "opLanguageEn",
  he: "opLanguageHe",
  pt: "opLanguagePt",
  es: "opLanguageEs",
  it: "opLanguageIt",
  mixed: "opLanguageMixed",
}

const ARTIFACT_LABEL_KEYS: Record<MeetArtifactView["artifactType"], string> = {
  recording: "opArtifactRecording",
  transcript: "opArtifactTranscript",
  smart_notes: "opArtifactSmartNotes",
}

const RUN_STATUS_KEYS: Record<string, string> = {
  sent: "opRunStatusSent",
  failed: "opRunStatusFailed",
  queued: "opRunStatusQueued",
  created: "opRunStatusCreated",
}

const defaultSettings: AppSettingsView = {
  defaultLocale: DEFAULT_LOCALE,
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

/** Label key for a meeting status, folded into the four pipeline buckets. */
export function meetingStatusLabelKey(status: string): string {
  if (status === "completed") return "opStatusCompleted"
  if (status === "failed") return "opStatusFailed"
  if (status === "scheduled" || status === "created") return "opStatusScheduled"
  return "opStatusProcessing"
}

function shortDate(i18n: I18nValue, value?: string) {
  return (value && i18n.fmt.date(value, "dateTime")) || i18n.t("opNoTime")
}

/** Error text for a failed response: localized code, never server English in Hebrew. */
function failure(i18n: I18nValue, body: unknown, fallbackKey: string): Error {
  return new Error(apiErrorText(body, i18n.t, i18n.t(fallbackKey), i18n.locale))
}

function errorText(i18n: I18nValue, error: unknown, fallbackKey: string) {
  return error instanceof Error && error.message ? error.message : i18n.t(fallbackKey)
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
            <div className="text-xs font-semibold uppercase tracking-wide text-brand-text">{eyebrow}</div>
            <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-foreground">{title}</h1>
            <p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
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
        {status && <Badge className="rounded-md bg-brand-soft text-brand-text">{status}</Badge>}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </section>
  )
}

function ManualBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="ms-card p-4">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <ul className="mt-3 grid gap-2">
        {items.map((item) => (
          <li
            key={item}
            className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm leading-6 text-muted-foreground"
          >
            {item}
          </li>
        ))}
      </ul>
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
        <p className="mt-1 text-sm leading-5 text-muted-foreground">{description}</p>
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

        if (!response.ok) throw new Error(status) // i18n-allow: internal control flow, never shown

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
  dictionary,
}: {
  dictionary: Dictionary
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
  const i18n = useI18n()
  const { t, plural, locale } = i18n
  const { can } = useWorkspace()
  const [rooms, setRooms] = useState<RoomResult[]>([])
  const [selectedRoomId, setSelectedRoomId] = useState("")
  const [roomDetail, setRoomDetail] = useState<RoomDetailView>()
  const [roomLoading, setRoomLoading] = useState(false)
  const [newRoomName, setNewRoomName] = useState("")
  const [roomCreating, setRoomCreating] = useState(false)
  const [webhookLoading, setWebhookLoading] = useState(false)
  const [realizeOSStatus, setRealizeOSStatus] = useState<RealizeOSStatusView>()
  const [realizeOSExports, setRealizeOSExports] = useState<RealizeOSExportView[]>([])
  const [mediaAssets, setMediaAssets] = useState<MediaAssetView[]>([])
  const [storageLoading, setStorageLoading] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<MediaAssetView>()
  const [settings, setSettings] = useState<AppSettingsView>(defaultSettings)
  const [settingsLoading, setSettingsLoading] = useState(false)
  // Settings are readable by every member; only admins may change them.
  const settingsReadOnly = !can("settings:write")
  const settingsDisabled = settingsLoading || settingsReadOnly
  // M9 A4: the section lives in the URL (`?section=`), so M8's
  // `?section=integrations` deep link and back/forward keep working.
  const settingsSection = useSettingsSection()
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
    // Reload only when the panel opens (messages are read at call time).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel])

  useEffect(() => {
    if (panel !== "storage") return

    void refreshStorage()
    void refreshSettings()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel])

  useEffect(() => {
    if (panel !== "workspace") return

    void refreshMeetArtifacts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel])

  async function openRoom(roomId: string) {
    setSelectedRoomId(roomId)
    setRoomLoading(true)
    try {
      const response = await fetch(`/api/rooms/${roomId}`)
      const body = await response.json()

      if (!response.ok) throw failure(i18n, body, "opErrLoadRoom")

      setRoomDetail(body)
    } catch (error) {
      toast.error(errorText(i18n, error, "opErrLoadRoom"))
      setRoomDetail(undefined)
    } finally {
      setRoomLoading(false)
    }
  }

  async function createRoom() {
    const name = newRoomName.trim()

    if (!name) return

    setRoomCreating(true)
    try {
      const response = await fetch("/api/contexts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      })
      const body = await response.json()

      if (!response.ok) throw failure(i18n, body, "opErrCreateRoom")

      toast.success(t("opRoomCreated", { name }))
      setNewRoomName("")
      const roomsResponse = await fetch("/api/rooms")
      const roomsBody = await roomsResponse.json()
      setRooms(roomsBody.rooms ?? [])
    } catch (error) {
      toast.error(errorText(i18n, error, "opErrCreateRoom"))
    } finally {
      setRoomCreating(false)
    }
  }

  async function copyAutomationText(value: string, label: string) {
    await navigator.clipboard.writeText(value)
    toast.success(t("opCopied", { label }))
  }

  async function refreshAutomations() {
    setWebhookLoading(true)
    try {
      const [realizeOSStatusResponse, realizeOSExportsResponse] = await Promise.all([
        fetch("/api/integrations/realizeos/status"),
        fetch("/api/integrations/realizeos/exports?limit=8"),
      ])
      const realizeOSStatusBody = await realizeOSStatusResponse.json()
      const realizeOSExportsBody = await realizeOSExportsResponse.json()

      if (realizeOSStatusResponse.ok) setRealizeOSStatus(realizeOSStatusBody.status)
      if (realizeOSExportsResponse.ok) setRealizeOSExports(realizeOSExportsBody.exports ?? [])
    } catch {
      toast.error(t("opErrRefreshAutomations"))
    } finally {
      setWebhookLoading(false)
    }
  }

  async function retryRealizeOSExport(run: RealizeOSExportView) {
    setWebhookLoading(true)
    try {
      const response = await fetch(`/api/integrations/realizeos/exports/${run.id}/retry`, { method: "POST" })
      const body = await response.json()

      if (!response.ok) throw failure(i18n, body, "opErrRetryExport")

      toast.success(t("opExportRetried"))
      await refreshAutomations()
    } catch (error) {
      toast.error(errorText(i18n, error, "opErrRetryExport"))
    } finally {
      setWebhookLoading(false)
    }
  }

  async function refreshStorage() {
    setStorageLoading(true)
    try {
      const response = await fetch("/api/storage/media-assets?limit=50")
      const body = await response.json()

      if (!response.ok) throw failure(i18n, body, "opErrLoadMedia")

      setMediaAssets(body.assets ?? [])
    } catch (error) {
      toast.error(errorText(i18n, error, "opErrLoadMedia"))
    } finally {
      setStorageLoading(false)
    }
  }

  async function deleteStoredMedia(asset: MediaAssetView) {
    setStorageLoading(true)
    try {
      const response = await fetch(`/api/storage/media-assets/${asset.id}`, { method: "DELETE" })
      const body = await response.json()

      if (!response.ok) throw failure(i18n, body, "opErrDeleteMedia")

      toast.success(t("opMediaDeleted"))
      await refreshStorage()
    } catch (error) {
      toast.error(errorText(i18n, error, "opErrDeleteMedia"))
    } finally {
      setStorageLoading(false)
    }
  }

  async function refreshSettings() {
    setSettingsLoading(true)
    try {
      const response = await fetch("/api/settings")
      const body = await response.json()

      if (!response.ok) throw failure(i18n, body, "opErrLoadSettings")

      setSettings({ ...defaultSettings, ...(body.settings ?? {}) })
    } catch (error) {
      toast.error(errorText(i18n, error, "opErrLoadSettings"))
    } finally {
      setSettingsLoading(false)
    }
  }

  async function refreshMeetArtifacts() {
    setMeetArtifactsLoading(true)
    try {
      const response = await fetch("/api/google/meet/artifacts?limit=10")
      const body = await response.json()

      if (!response.ok) throw failure(i18n, body, "opErrMeetStatus")

      setMeetArtifactsError("")
      setMeetArtifacts({
        setup: body.setup,
        conferenceRecords: body.conferenceRecords ?? [],
        persistedRecords: body.persistedRecords ?? [],
      })
    } catch (error) {
      const message = errorText(i18n, error, "opErrMeetStatus")

      setMeetArtifactsError(message)
      toast.error(message)
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

      if (!response.ok) throw failure(i18n, body, "opErrSyncMeet")

      toast.success(t("opMeetSynced"))
      await refreshMeetArtifacts()
    } catch (error) {
      const message = errorText(i18n, error, "opErrSyncMeet")

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

      if (!response.ok) throw failure(i18n, body, "opErrSaveSettings")

      setSettings({ ...defaultSettings, ...(body.settings ?? {}) })
      toast.success(t("opSettingsSaved"))
    } catch (error) {
      setSettings(settings)
      toast.error(errorText(i18n, error, "opErrSaveSettings"))
    } finally {
      setSettingsLoading(false)
    }
  }

  const meetingLanguageOptions = (
    <>
      <NativeSelectOption value="auto">{t("settingsMeetingLanguageAuto")}</NativeSelectOption>
      {CONTENT_LANGUAGES.map((language) => (
        <NativeSelectOption key={language} value={language}>
          {t(CONTENT_LANGUAGE_LABEL_KEYS[language])}
        </NativeSelectOption>
      ))}
    </>
  )

  if (panel === "workspace") {
    const authorized = Boolean(meetArtifacts?.setup?.authorized)

    return (
      <PageFrame eyebrow={t("opWorkspaceEyebrow")} title={t("opWorkspaceTitle")} description={t("opWorkspaceDescription")}>
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
              title={t("opLiveCaptureTitle")}
              description={t("opLiveCaptureDescription")}
              status={authorized ? t("opArtifactsAuthorized") : t("opGoogleArtifactsFirstStatus")}
            >
              <div className="grid gap-2 text-sm text-muted-foreground">
                <div className="flex items-center justify-between rounded-lg border border-line bg-surface-2 p-3">
                  <span>{t("opReadinessRow")}</span>
                  <Badge variant="outline" className={authorized ? "rounded-md border-ok text-ok-text" : "rounded-md"}>
                    {authorized ? t("opAuthorized") : t("opChecklist")}
                  </Badge>
                </div>
                {meetArtifacts?.setup?.message ? (
                  <div className="rounded-md border border-warn/40 bg-surface-2 px-3 py-2 text-xs leading-5 text-warn-text">
                    {/* The setup message is server English; Hebrew shows the localized hint. */}
                    {locale === "en" ? meetArtifacts.setup.message : t("opMeetSetupNeeded")}
                  </div>
                ) : null}
                {meetArtifactsError ? (
                  <div role="alert" className="rounded-md border border-danger/40 bg-warn-soft px-3 py-2 text-xs leading-5 text-warn-text">
                    {meetArtifactsError}
                  </div>
                ) : null}
                {meetArtifacts ? (
                  <dl className="grid grid-cols-3 gap-2">
                    {(
                      [
                        ["opLiveRecords", meetArtifacts.conferenceRecords.length],
                        ["opPersisted", meetArtifacts.persistedRecords.length],
                        [
                          "opArtifacts",
                          meetArtifacts.persistedRecords.reduce((total, record) => total + record.artifacts.length, 0),
                        ],
                      ] as const
                    ).map(([labelKey, value]) => (
                      <div key={labelKey} className="rounded-md border border-line bg-surface-2 p-2">
                        <dt className="text-xs text-muted-foreground">{t(labelKey)}</dt>
                        <dd className="mt-1 font-semibold text-foreground">{i18n.fmt.number(value)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                <Button className="h-10 w-full" variant="outline" onClick={onFindDriveRecordings}>
                  <FileAudioIcon data-icon="inline-start" className="size-4" />
                  {dictionary.findDriveRecordings}
                </Button>
                <Button
                  className="h-10 w-full"
                  variant="outline"
                  disabled={meetArtifactsLoading || syncing}
                  onClick={syncMeetArtifactsAndRefresh}
                >
                  <RadioTowerIcon data-icon="inline-start" className="size-4" />
                  {meetArtifactsLoading ? t("opCheckingArtifacts") : t("opSyncMeetArtifacts")}
                </Button>
                {meetArtifacts?.persistedRecords.length ? (
                  <div className="mt-2 grid gap-2">
                    {meetArtifacts.persistedRecords.slice(0, 4).map((record) => (
                      <div key={record.id} className="rounded-md border border-line bg-surface-2 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-foreground">
                              <bdi>
                                {i18n.text(record.meetingTitle ?? record.calendarTitle ?? record.conferenceRecordName)}
                              </bdi>
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">{shortDate(i18n, record.startTime)}</div>
                          </div>
                          <Badge variant="outline" className="shrink-0 rounded-md">
                            {plural("opArtifactsCount", record.artifacts.length, {
                              count: i18n.fmt.number(record.artifacts.length),
                            })}
                          </Badge>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {record.artifacts.length ? (
                            record.artifacts.slice(0, 5).map((artifact) => (
                              <span
                                key={artifact.id}
                                className="rounded-sm bg-brand-soft px-2 py-0.5 text-2xs font-medium text-brand-text"
                              >
                                {t(ARTIFACT_LABEL_KEYS[artifact.artifactType])}
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-muted-foreground">{t("opNoArtifactsForRecord")}</span>
                          )}
                        </div>
                        {record.meetingId && record.artifacts.length ? (
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button size="sm" variant="outline" className="h-8" onClick={() => onOpenMeeting(record.meetingId!)}>
                              {t("opOpenMeeting")}
                            </Button>
                            <Button size="sm" className="h-8" onClick={() => onProcessMeeting(record.meetingId!)}>
                              {t("opProcessArtifacts")}
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
              <h3 className="text-sm font-semibold">{t("opPipelineTitle")}</h3>
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(
                  [
                    ["opStatusCompleted", meetingTotals?.completed, "bg-ok/10 text-ok-text"],
                    ["opStatusProcessing", meetingTotals?.processing, "bg-brand/10 text-brand-text"],
                    ["opStatusFailed", meetingTotals?.failed, "bg-destructive/10 text-destructive"],
                    ["opStatusScheduled", meetingTotals?.scheduled, "bg-surface-2/50 text-muted-foreground"],
                  ] as const
                ).map(([labelKey, count, classes]) => (
                  <div key={labelKey} className={`flex flex-col-reverse rounded-lg border border-line p-3 ${classes}`}>
                    <dt className="text-xs">{t(labelKey)}</dt>
                    <dd className="text-xl font-semibold">{count === undefined ? "—" : i18n.fmt.number(count)}</dd>
                  </div>
                ))}
              </dl>
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
                    {t("opRetryAllFailed", { count: i18n.fmt.number(failedJobs.length) })}
                  </button>
                ) : null
              })()}
            </section>
          </div>
          <div className="xl:col-span-2">
            <JobActivityCenter jobs={jobs} meetings={meetings} onRetry={onRetryJob} onOpenMeeting={onOpenMeeting} />
          </div>
        </div>
      </PageFrame>
    )
  }

  if (panel === "memory") {
    return (
      <PageFrame eyebrow={dictionary.navMemory} title={dictionary.searchTitle} description={dictionary.searchSubtitle}>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="lg:col-span-2">
            <CompactSearchBox locale={locale} dictionary={dictionary} initialQuery={query} />
          </div>
          <div className="lg:col-span-2">
            <OpsCard
              icon={LinkIcon}
              title={t("opRoomsTitle")}
              description={t("opRoomsDescription")}
              status={plural("opRoomsCount", rooms.length, { count: i18n.fmt.number(rooms.length) })}
            >
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {rooms.map((room) => (
                  <button
                    className="rounded-lg border border-line bg-surface-2 p-3 text-start transition hover:border-brand/50 hover:bg-brand-soft"
                    key={room.id}
                    onClick={() => openRoom(room.id)}
                    aria-pressed={selectedRoomId === room.id}
                    type="button"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 truncate text-sm font-semibold">
                        <bdi dir="auto">{room.name}</bdi>
                      </div>
                      {selectedRoomId === room.id ? <Badge className="rounded-sm">{t("opRoomOpenBadge")}</Badge> : null}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {plural("opLinkedMeetings", room.meetingCount, { count: i18n.fmt.number(room.meetingCount) })}
                    </div>
                  </button>
                ))}
                {!rooms.length ? (
                  <div className="rounded-lg border border-dashed border-line p-4 text-sm text-muted-foreground">
                    {t("opNoRooms")}
                  </div>
                ) : null}
                <div className="col-span-full mt-1">
                  <div className="flex items-center gap-2">
                    <input
                      className="flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand focus:outline-none"
                      aria-label={t("opNewRoomLabel")}
                      placeholder={t("opNewRoomPlaceholder")}
                      dir="auto"
                      value={newRoomName}
                      onChange={(e) => setNewRoomName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void createRoom()
                      }}
                    />
                    <button
                      className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-on-brand transition hover:opacity-90 disabled:opacity-50"
                      disabled={!newRoomName.trim() || roomCreating}
                      onClick={() => void createRoom()}
                      type="button"
                    >
                      {roomCreating ? t("opCreating") : t("opCreateRoom")}
                    </button>
                  </div>
                </div>
              </div>
              {roomLoading ? (
                <div role="status" className="mt-4 rounded-lg border border-line bg-surface-2 p-4 text-sm text-muted-foreground">
                  {t("opLoadingRoom")}
                </div>
              ) : roomDetail ? (
                <div className="mt-4 grid gap-4">
                  <div className="rounded-lg border border-line bg-surface-2 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-base font-semibold text-foreground">
                          <bdi dir="auto">{roomDetail.room.name}</bdi>
                        </div>
                        <p className="mt-1 max-w-2xl text-sm text-muted-foreground" dir={roomDetail.room.description ? "auto" : undefined}>
                          {roomDetail.room.description ?? t("opRoomDefaultDescription")}
                        </p>
                      </div>
                      <Badge variant="outline" className="rounded-md">
                        {plural("coreMeetingsCount", roomDetail.stats.meetings, {
                          count: i18n.fmt.number(roomDetail.stats.meetings),
                        })}
                      </Badge>
                    </div>
                    <dl className="mt-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                      {(
                        [
                          ["opStatCompleted", roomDetail.stats.completedMeetings],
                          ["opStatProcessing", roomDetail.stats.processingMeetings],
                          ["opStatOpenTasks", roomDetail.stats.openTasks],
                          ["opStatPeople", roomDetail.stats.participants],
                          ["opStatArtifacts", roomDetail.stats.artifacts],
                          ["opStatMeetings", roomDetail.stats.meetings],
                        ] as const
                      ).map(([labelKey, value]) => (
                        <div className="flex flex-col-reverse rounded-md border border-line bg-surface p-3" key={labelKey}>
                          <dt className="text-2xs text-muted-foreground">{t(labelKey)}</dt>
                          <dd className="text-lg font-semibold">{i18n.fmt.number(value)}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                  <div className="grid gap-4 xl:grid-cols-3">
                    <div className="xl:col-span-2">
                      <h3 className="mb-2 text-sm font-semibold">{t("opRecentMeetings")}</h3>
                      <div className="grid gap-2">
                        {roomDetail.meetings.slice(0, 6).map((meeting) => (
                          <div className="rounded-lg border border-line bg-surface-2 p-3" key={meeting.id}>
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0 truncate text-sm font-semibold">
                                <bdi>{i18n.text(meeting.title)}</bdi>
                              </div>
                              <Badge variant="outline" className="rounded-sm">
                                {t(meetingStatusLabelKey(meeting.status))}
                              </Badge>
                            </div>
                            <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground" dir={meeting.overview ? "auto" : undefined}>
                              {meeting.overview ? i18n.text(meeting.overview) : t("opNoSummaryYet")}
                            </p>
                            <div className="mt-2 flex flex-wrap gap-2 text-2xs text-muted-foreground">
                              <span>{shortDate(i18n, meeting.startedAt)}</span>
                              <span>{plural("opOpenTasksCount", meeting.openTasks, { count: i18n.fmt.number(meeting.openTasks) })}</span>
                              <span>{plural("opPeopleCount", meeting.participants, { count: i18n.fmt.number(meeting.participants) })}</span>
                              <span>{plural("opArtifactsCount", meeting.artifacts, { count: i18n.fmt.number(meeting.artifacts) })}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="grid content-start gap-4">
                      <div>
                        <h3 className="mb-2 text-sm font-semibold">{t("opStatOpenTasks")}</h3>
                        <div className="grid gap-2">
                          {roomDetail.openTasks.slice(0, 5).map((task) => (
                            <div className="rounded-lg border border-line bg-surface-2 p-3 text-xs" key={task.id}>
                              <div className="font-medium text-foreground">
                                <bdi>{i18n.text(task.title)}</bdi>
                              </div>
                              <div className="mt-1 text-muted-foreground">
                                <bdi>{i18n.text(task.meetingTitle)}</bdi>
                                {task.owner ? (
                                  <>
                                    {" · "}
                                    <bdi>{task.owner}</bdi>
                                  </>
                                ) : null}
                              </div>
                            </div>
                          ))}
                          {!roomDetail.openTasks.length ? (
                            <div className="rounded-lg border border-dashed border-line p-3 text-xs text-muted-foreground">
                              {t("opNoOpenTasks")}
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <div>
                        <h3 className="mb-2 text-sm font-semibold">{t("opStatPeople")}</h3>
                        <div className="flex flex-wrap gap-1.5">
                          {roomDetail.participants.slice(0, 8).map((participant) => (
                            <span
                              className="rounded-sm bg-brand-soft px-2 py-1 text-2xs text-brand-text"
                              key={participant.email ?? participant.name}
                            >
                              <bdi>{participant.name}</bdi> · {i18n.fmt.number(participant.meetingCount)}
                            </span>
                          ))}
                          {!roomDetail.participants.length ? (
                            <span className="text-xs text-muted-foreground">{t("opNoParticipants")}</span>
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
      <PageFrame eyebrow={t("opAutomationsEyebrow")} title={t("opAutomationsTitle")} description={t("opAutomationsDescription")}>
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
          {/* M8: webhook subscriptions and their delivery log moved to Settings → Integrations. */}
          <OpsCard icon={WorkflowIcon} title={t("opWebhookSubscriptions")} description={dictionary.integrationsWebhooksMovedHint}>
            <Button
              variant="outline"
              className="h-9 w-fit"
              nativeButton={false}
              render={<a href={buildShellUrl(locale, { panel: "settings", section: "integrations" })} />}
            >
              {dictionary.integrationsTitle}
            </Button>
          </OpsCard>

          <div className="grid gap-4">
            <OpsCard
              icon={BotIcon}
              title="RealizeOS"
              description={t("opRealizeosDescription")}
              status={realizeOSStatus?.configured ? t("opConfigured") : t("opNeedsSetup")}
            >
              <div className="grid gap-2">
                <div className="rounded-md border border-line bg-surface-2 p-3 text-sm">
                  <div className="font-medium text-foreground">
                    {realizeOSStatus?.configured ? (
                      <bdi dir="ltr" className="font-mono text-xs">{`${realizeOSStatus.baseUrl}${realizeOSStatus.path}`}</bdi>
                    ) : (
                      t("opRealizeosUrlMissing")
                    )}
                  </div>
                  <p className="mt-1 leading-5 text-muted-foreground">
                    {!realizeOSStatus
                      ? t("opRealizeosStatusPending")
                      : locale === "en"
                        ? realizeOSStatus.message
                        : realizeOSStatus.configured
                          ? t("opRealizeosConfiguredHint")
                          : t("opNeedsSetup")}
                  </p>
                </div>
                <Button variant="outline" className="h-9 w-full justify-start" onClick={() => toast.info(t("opExportFlowHint"))}>
                  {t("opViewExportFlow")}
                </Button>
                <Button
                  variant="outline"
                  className="h-9 w-full justify-start"
                  onClick={() => copyAutomationText(REALIZEOS_PAYLOAD_FIELDS, t("opPayloadFieldsLabel"))}
                >
                  {t("opCopyPayloadFields")}
                </Button>
                <div className="grid gap-2 pt-1">
                  {realizeOSExports.map((run) => (
                    <div key={run.id} className="rounded-md border border-line bg-surface-2 p-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-muted-foreground" dir="ltr">
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
                          {RUN_STATUS_KEYS[run.status] ? t(RUN_STATUS_KEYS[run.status]!) : run.status}
                        </Badge>
                      </div>
                      {run.lastError ? (
                        <div className="mt-2 rounded-sm bg-destructive/10 px-2 py-1 text-destructive" dir="auto">
                          {run.lastError}
                        </div>
                      ) : null}
                      {run.response && Object.keys(run.response).length > 0 ? (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-2xs font-medium text-brand-text hover:underline">
                            {t("opResponsePayload")}
                          </summary>
                          <pre
                            dir="ltr"
                            className="mt-1.5 max-h-40 overflow-auto rounded-md border border-line bg-surface p-2 font-mono text-2xs leading-4 text-muted-foreground"
                          >
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
                          {t("opRetryExport")}
                        </Button>
                        {run.response ? (
                          <Button
                            variant="outline"
                            className="h-7"
                            onClick={() => copyAutomationText(JSON.stringify(run.response, null, 2), t("opRealizeosResponseLabel"))}
                          >
                            {t("opCopyResponse")}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                  {!realizeOSExports.length ? (
                    <div className="rounded-md border border-dashed border-line bg-surface-2 p-3 text-xs text-muted-foreground">
                      {t("opNoExports")}
                    </div>
                  ) : null}
                </div>
              </div>
            </OpsCard>
            <OpsCard icon={LinkIcon} title="n8n" description={t("opN8nDescription")} status={t("opPrepared")}>
              <div className="grid gap-2">
                <Button
                  variant="outline"
                  className="h-9 w-full justify-start"
                  onClick={() => copyAutomationText("x-meetsum-signature", t("opSignatureHeaderLabel"))}
                >
                  {t("opCopySignatureHeader")}
                </Button>
                <Button
                  variant="outline"
                  className="h-9 w-full justify-start"
                  onClick={() => copyAutomationText(WEBHOOK_EVENT_NAMES.join(", "), t("opEventListLabel"))}
                >
                  {t("opCopyEventNames")}
                </Button>
              </div>
            </OpsCard>
          </div>

          <div className="xl:col-span-2">
            <JobRecoveryPanel jobs={jobs} meetings={meetings} onRetry={onRetryJob} onOpenMeeting={onOpenMeeting} />
          </div>
          <div className="xl:col-span-2">
            <JobActivityCenter jobs={jobs} onRetry={onRetryJob} />
          </div>
        </div>
      </PageFrame>
    )
  }

  if (panel === "storage") {
    const retainedBytes = mediaAssets.reduce((sum, asset) => sum + asset.sizeBytes, 0)
    const assetCount = (count: number) => plural("opAssetsCount", count, { count: i18n.fmt.number(count) })

    return (
      <PageFrame eyebrow={t("opStorageEyebrow")} title={t("opStorageTitle")} description={t("opStorageDescription")}>
        <div className="grid gap-4 lg:grid-cols-3">
          <OpsCard
            icon={DatabaseIcon}
            title={t("opMediaAssets")}
            description={t("opMediaAssetsDescription")}
            status={assetCount(mediaAssets.length)}
          >
            <div className="text-sm text-muted-foreground">
              {t("opTrackedBytes", { size: formatBytes(retainedBytes, { locale, timeZone: i18n.timeZone }) })}
            </div>
          </OpsCard>
          <OpsCard
            icon={ShieldCheckIcon}
            title={t("opRetentionPolicy")}
            description={t("opRetentionPolicyDescription")}
            status={t("opActive")}
          >
            <div className="grid gap-2 text-sm text-muted-foreground">
              <p>
                {settingsLoading
                  ? t("opRetentionAudioLoading")
                  : plural("opRetentionAudioDays", settings.audioRetentionDays, {
                      count: i18n.fmt.number(settings.audioRetentionDays),
                    })}
              </p>
              <p>
                {settingsLoading
                  ? t("opRetentionVideoLoading")
                  : settings.retainVideoByDefault
                    ? t("opRetentionVideoKept")
                    : t("opRetentionVideoAudio")}
              </p>
              <p>{t("opRetentionTranscripts")}</p>
            </div>
          </OpsCard>
          <OpsCard icon={CloudIcon} title={t("opBackups")} description={t("opBackupsDescription")} status={t("opConfigured")}>
            <p className="text-sm text-muted-foreground">{t("opBackupsBody")}</p>
          </OpsCard>
          <div className="lg:col-span-3">
            <OpsCard
              icon={FileAudioIcon}
              title={t("opRecentMedia")}
              description={t("opRecentMediaDescription")}
              status={
                storageLoading
                  ? t("opLoadingStatus")
                  : plural("opListedCount", mediaAssets.length, { count: i18n.fmt.number(mediaAssets.length) })
              }
            >
              <div className="mb-3 flex justify-end">
                <Button variant="outline" className="h-8" disabled={storageLoading} onClick={refreshStorage}>
                  {t("opRefreshAssets")}
                </Button>
              </div>
              <div className="grid gap-2">
                {mediaAssets.map((asset) => (
                  <div key={asset.id} className="rounded-lg border border-line bg-surface-2 p-3">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-foreground">
                          <bdi>{asset.filename ?? i18n.text(asset.meetingTitle)}</bdi>
                        </div>
                        <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                          <bdi>{i18n.text(asset.meetingTitle)}</bdi>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          <span className="rounded-sm bg-brand-soft px-2 py-0.5 text-2xs font-medium text-brand-text">
                            {asset.retention === "video" ? t("opRetentionTagVideo") : t("opRetentionTagAudio")}
                          </span>
                          <span className="rounded-sm bg-surface px-2 py-0.5 font-mono text-2xs text-muted-foreground" dir="ltr">
                            {asset.contentType}
                          </span>
                          <span className="rounded-sm bg-surface px-2 py-0.5 text-2xs text-muted-foreground">
                            {formatBytes(asset.sizeBytes, { locale, timeZone: i18n.timeZone })}
                          </span>
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        className="h-8 shrink-0 text-destructive hover:text-destructive"
                        disabled={storageLoading}
                        onClick={() => setPendingDelete(asset)}
                      >
                        <Trash2Icon data-icon="inline-start" className="size-4" />
                        {t("opDeleteMedia")}
                      </Button>
                    </div>
                  </div>
                ))}
                {!mediaAssets.length ? (
                  <div className="rounded-lg border border-dashed border-line bg-surface-2 p-4 text-sm text-muted-foreground">
                    {t("opNoMedia")}
                  </div>
                ) : null}
              </div>
            </OpsCard>
          </div>
        </div>
        <ConfirmDialog
          open={Boolean(pendingDelete)}
          onOpenChange={(open) => {
            if (!open) setPendingDelete(undefined)
          }}
          title={t("settingsDeleteMediaTitle", {
            name: pendingDelete?.filename ?? (pendingDelete ? i18n.text(pendingDelete.meetingTitle) : t("opThisMediaAsset")),
          })}
          description={t("settingsDeleteMediaDescription")}
          confirmLabel={t("opDeleteMedia")}
          cancelLabel={t("coreCancel")}
          onConfirm={async () => {
            if (pendingDelete) await deleteStoredMedia(pendingDelete)
          }}
        />
      </PageFrame>
    )
  }

  if (panel === "manual") {
    const items = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => t(`${prefix}${index + 1}`))

    return (
      <PageFrame eyebrow={t("opManualEyebrow")} title={t("opManualTitle")} description={t("opManualDescription")}>
        <div className="grid gap-4 lg:grid-cols-3">
          <OpsCard icon={BookOpenIcon} title={t("opBasicLogic")} description={t("opBasicLogicDescription")} status="V0.1">
            <ol className="grid list-decimal gap-2 ps-5 text-sm leading-6 text-muted-foreground">
              {items("opBasicLogic", 4).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
          </OpsCard>
          <OpsCard icon={RadioTowerIcon} title={t("opCaptureModel")} description={t("opCaptureModelDescription")} status={dictionary.audioFirst}>
            <div className="grid gap-2 text-sm leading-6 text-muted-foreground">
              {items("opCapture", 3).map((item) => (
                <p key={item}>{item}</p>
              ))}
            </div>
          </OpsCard>
          <OpsCard
            icon={WorkflowIcon}
            title={t("opAutomationSurfaces")}
            description={t("opAutomationSurfacesDescription")}
            status={t("opConnected")}
          >
            <div className="grid gap-2 text-sm leading-6 text-muted-foreground">
              {items("opSurfaces", 3).map((item) => (
                <p key={item}>{item}</p>
              ))}
            </div>
          </OpsCard>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <ManualBlock title={t("opDailyWorkflow")} items={items("opDaily", 5)} />
          <ManualBlock title={t("opOutputs")} items={items("opOutputs", 5)} />
          <ManualBlock title={t("opDataRetention")} items={items("opData", 5)} />
          <ManualBlock title={t("opLimitations")} items={items("opLimit", 5)} />
        </div>
      </PageFrame>
    )
  }

  return (
    <PageFrame eyebrow={t("settingsPageEyebrow")} title={t("settingsPageTitle")} description={t("settingsPageDescription")}>
      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <SettingsNav current={settingsSection} />
        <div className="grid gap-4">
          {settingsReadOnly ? (
            <div
              role="status"
              className="flex items-center gap-2 rounded-lg border border-line bg-surface p-3 text-sm text-muted-foreground"
            >
              <ShieldCheckIcon aria-hidden="true" className="size-4 shrink-0" />
              {dictionary.settingsReadOnly}
            </div>
          ) : null}
          {settingsSection === "recording" ? (
            <OpsCard
              icon={RadioTowerIcon}
              title={t("settingsSectionRecording")}
              description={t("opRecordingDescription")}
              status={settingsLoading ? t("opSaving") : t("coreSaved")}
            >
              <div className="grid gap-3">
                <SettingRow title={t("opGoogleArtifactsFirstTitle")} description={t("opGoogleArtifactsFirstDescription")}>
                  <Switch
                    aria-label={t("opGoogleArtifactsFirstTitle")}
                    checked={settings.googleArtifactsFirst}
                    disabled={settingsDisabled}
                    onCheckedChange={(checked) => saveSettingsPatch({ googleArtifactsFirst: Boolean(checked) })}
                  />
                </SettingRow>
                <SettingRow title={t("opPwaRecorderTitle")} description={t("opPwaRecorderDescription")}>
                  <Switch
                    aria-label={t("opPwaRecorderTitle")}
                    checked={settings.pwaRecorderEnabled}
                    disabled={settingsDisabled}
                    onCheckedChange={(checked) => saveSettingsPatch({ pwaRecorderEnabled: Boolean(checked) })}
                  />
                </SettingRow>
                <SettingRow title={t("opAutoProcessTitle")} description={t("opAutoProcessDescription")}>
                  <Switch
                    aria-label={t("opAutoProcessTitle")}
                    checked={settings.autoProcessImportedMedia}
                    disabled={settingsDisabled}
                    onCheckedChange={(checked) => saveSettingsPatch({ autoProcessImportedMedia: Boolean(checked) })}
                  />
                </SettingRow>
                <SettingRow title={dictionary.settingsKeepVideoTitle} description={dictionary.settingsKeepVideoDescription}>
                  <Switch
                    aria-label={dictionary.settingsKeepVideoTitle}
                    checked={settings.retainVideoByDefault}
                    disabled={settingsDisabled}
                    onCheckedChange={(checked) => saveSettingsPatch({ retainVideoByDefault: Boolean(checked) })}
                  />
                </SettingRow>
                <SettingRow title={t("opAudioRetentionTitle")} description={t("opAudioRetentionDescription")}>
                  <Input
                    aria-label={t("opAudioRetentionTitle")}
                    className="h-9 w-24"
                    type="number"
                    min={1}
                    max={3650}
                    value={settings.audioRetentionDays}
                    disabled={settingsDisabled}
                    onChange={(event) => setSettings({ ...settings, audioRetentionDays: Number(event.target.value) })}
                    onBlur={() => saveSettingsPatch({ audioRetentionDays: settings.audioRetentionDays })}
                  />
                </SettingRow>
              </div>
            </OpsCard>
          ) : null}
          {settingsSection === "ai" ? (
            <>
              <OpsCard
                icon={CitedMark}
                title={t("settingsSectionAi")}
                description={t("opAiDescription")}
                status={providers.find((provider) => provider.id === "gemini")?.mode ?? "Gemini"}
              >
                {/* The default summary template lives in LlmSettings below
                    (built-in and workspace templates). */}
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
              <LlmSettings dictionary={dictionary} locale={settings.defaultLocale} readOnly={settingsReadOnly} />
              <TemplatesSettings dictionary={dictionary} locale={settings.defaultLocale} readOnly={settingsReadOnly} />
              <AsrGlossaryEditor dictionary={dictionary} />
            </>
          ) : null}
          {settingsSection === "live" ? (
            <>
              <OpsCard
                icon={RadioTowerIcon}
                title={t("opLiveCaptureTitle")}
                description={t("opLiveSettingsDescription")}
                status={t("opGoogleFirst")}
              >
                <div className="grid gap-3">
                  <SettingRow title={t("settingsMeetingLanguage")} description={t("opMeetingContentLanguageDescription")}>
                    <NativeSelect
                      aria-label={t("settingsMeetingLanguage")}
                      value={settings.meetingLanguageMode}
                      disabled={settingsDisabled}
                      onChange={(event) =>
                        saveSettingsPatch({ meetingLanguageMode: event.target.value as AppSettingsView["meetingLanguageMode"] })
                      }
                    >
                      {meetingLanguageOptions}
                    </NativeSelect>
                  </SettingRow>
                </div>
              </OpsCard>
              <BotRulesSettings dictionary={dictionary} />
            </>
          ) : null}
          {settingsSection === "integrations" ? <IntegrationsSettings dictionary={dictionary} /> : null}
          {settingsSection === "personal" ? <PersonalPreferences /> : null}
          {settingsSection === "notifications" ? <NotificationPreferences /> : null}
          {settingsSection === "developer" ? (
            <OpsCard
              icon={KeyRoundIcon}
              title={t("settingsSectionDeveloper")}
              description={t("opDeveloperDescription")}
              status={t("opHardened")}
            >
              <div className="grid gap-3">
                <SettingRow title={t("opWebhookSigning")} description={t("opWebhookSigningDescription")}>
                  <Badge className="rounded-md bg-brand-soft text-brand-text">{t("opEnabled")}</Badge>
                </SettingRow>
                <SettingRow title={t("opMcpCli")} description={t("opMcpCliDescription")}>
                  <Button variant="outline" className="h-8" onClick={() => copyAutomationText("MEETSUM_API_KEY", t("opApiKeyEnvLabel"))}>
                    {t("opCopyEnvName")}
                  </Button>
                </SettingRow>
              </div>
            </OpsCard>
          ) : null}
          {settingsSection === "language" ? (
            <OpsCard
              icon={BookOpenIcon}
              title={t("settingsSectionLanguage")}
              description={t("opLanguageDescription")}
              status={settings.defaultLocale.toUpperCase()}
            >
              <div className="grid gap-3">
                <SettingRow title={t("settingsInterfaceLanguage")} description={t("opInterfaceLanguageDescription")}>
                  <NativeSelect
                    aria-label={t("settingsInterfaceLanguage")}
                    value={settings.defaultLocale}
                    disabled={settingsDisabled}
                    onChange={(event) => saveSettingsPatch({ defaultLocale: event.target.value as SupportedLocale })}
                  >
                    {SUPPORTED_LOCALES.map((item) => (
                      <NativeSelectOption key={item} value={item} lang={item}>
                        {t(LOCALE_LABEL_KEYS[item])}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </SettingRow>
                <SettingRow title={t("settingsMeetingLanguage")} description={t("opMeetingLanguageDescription")}>
                  <NativeSelect
                    aria-label={t("settingsMeetingLanguage")}
                    value={settings.meetingLanguageMode}
                    disabled={settingsDisabled}
                    onChange={(event) =>
                      saveSettingsPatch({ meetingLanguageMode: event.target.value as AppSettingsView["meetingLanguageMode"] })
                    }
                  >
                    {meetingLanguageOptions}
                  </NativeSelect>
                </SettingRow>
              </div>
            </OpsCard>
          ) : null}
          {settingsSection === "account" ? (
            <OpsCard
              icon={ShieldCheckIcon}
              title={t("settingsSectionAccount")}
              description={t("opAccountDescription")}
              status={t("opGoogleSignIn")}
            >
              <div className="grid gap-3">
                <SettingRow title={t("opPrimaryAdmin")} description={t("opPrimaryAdminDescription")}>
                  <span className="font-mono text-xs text-muted-foreground">
                    {workspaceStatus ? (
                      workspaceStatus.google.subject ? (
                        <bdi dir="ltr">{workspaceStatus.google.subject}</bdi>
                      ) : (
                        t("opNotConfigured")
                      )
                    ) : (
                      t("opChecking")
                    )}
                  </span>
                </SettingRow>
                <SettingRow title={dictionary.settingsDefaultVisibilityTitle} description={dictionary.settingsDefaultVisibilityDescription}>
                  <NativeSelect
                    aria-label={dictionary.settingsDefaultVisibilityTitle}
                    value={settings.defaultMeetingVisibility}
                    disabled={settingsDisabled}
                    onChange={(event) =>
                      saveSettingsPatch({
                        defaultMeetingVisibility: event.target.value as AppSettingsView["defaultMeetingVisibility"],
                      })
                    }
                  >
                    <NativeSelectOption value="workspace">{dictionary.visibilityWorkspace}</NativeSelectOption>
                    <NativeSelectOption value="private">{dictionary.visibilityPrivate}</NativeSelectOption>
                  </NativeSelect>
                </SettingRow>
                <SettingRow title={t("opPublicSharingTitle")} description={t("opPublicSharingDescription")}>
                  <Switch
                    aria-label={t("opPublicSharingTitle")}
                    checked={settings.publicSharingEnabled}
                    disabled={settingsDisabled}
                    onCheckedChange={(checked) => saveSettingsPatch({ publicSharingEnabled: Boolean(checked) })}
                  />
                </SettingRow>
                <SettingRow title={t("opShareTranscriptTitle")} description={t("opShareDefaultDescription")}>
                  <Switch
                    aria-label={t("opShareTranscriptTitle")}
                    checked={settings.shareTranscriptByDefault}
                    disabled={settingsDisabled}
                    onCheckedChange={(checked) => saveSettingsPatch({ shareTranscriptByDefault: Boolean(checked) })}
                  />
                </SettingRow>
                <SettingRow title={t("opShareActionsTitle")} description={t("opShareDefaultDescription")}>
                  <Switch
                    aria-label={t("opShareActionsTitle")}
                    checked={settings.shareActionsByDefault}
                    disabled={settingsDisabled}
                    onCheckedChange={(checked) => saveSettingsPatch({ shareActionsByDefault: Boolean(checked) })}
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
