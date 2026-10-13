import {
  AlertTriangleIcon,
  CalendarSyncIcon,
  CheckCircle2Icon,
  CloudIcon,
  Loader2Icon,
  RadioTowerIcon,
} from "lucide-react"
import Link from "next/link"

import { useI18n } from "@/components/i18n-provider"
import { JOB_STATUS_KEYS } from "@/components/pipeline-timeline"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

export type WorkspaceStatusView = {
  google: {
    subject: string | null
    strategy: "user-oauth" | "keyless-iam-signjwt" | "json-key" | "key-file" | "missing"
    configured: boolean
    detail: string
    serviceAccountEmail?: string
    serviceAccountEmailConfigured: boolean
    serviceAccountKeyConfigured: boolean
    keyFileConfigured: boolean
    userOAuthConnected?: boolean
  }
  sync: Array<{
    source: string
    status: string
    updatedAt?: string
    lastSyncedAt?: string
    nextPollAt?: string
    lastError?: string
    stats?: Record<string, unknown>
  }>
  jobs: {
    queued: number
    active: number
    failed: number
  }
}

const STRATEGY_KEYS: Record<WorkspaceStatusView["google"]["strategy"], string> = {
  "user-oauth": "opsSyncStrategyUserOauth",
  "keyless-iam-signjwt": "opsSyncStrategyKeyless",
  "json-key": "opsSyncStrategyJsonKey",
  "key-file": "opsSyncStrategyKeyFile",
  missing: "opsSyncStrategyMissing",
}

const SOURCE_KEYS: Record<string, string> = {
  calendar: "opsSyncSourceCalendar",
}

const SYNC_STATUS_KEYS: Record<string, string> = {
  idle: "opsSyncStatusIdle",
  running: "opsSyncStatusRunning",
  completed: JOB_STATUS_KEYS.completed,
  failed: JOB_STATUS_KEYS.failed,
}

export function WorkspaceSyncPanel({
  status,
  syncing,
  onSyncAll,
  onSyncMeetArtifacts,
}: {
  status?: WorkspaceStatusView
  syncing?: boolean
  onSyncAll: () => void
  onSyncMeetArtifacts: () => void
}) {
  const { t, plural, fmt, locale } = useI18n()
  const label = (keys: Record<string, string>, value: string) => (keys[value] ? t(keys[value]) : value)

  return (
    <section className="ms-card grid gap-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CloudIcon aria-hidden="true" className="size-4 text-primary" />
          <h3 className="text-sm font-semibold">Google Workspace</h3>
        </div>
        <Badge
          variant={status?.google.strategy === "missing" ? "outline" : "secondary"}
          className="rounded-sm"
        >
          {status ? label(STRATEGY_KEYS, status.google.strategy) : t("opsSyncChecking")}
        </Badge>
      </div>
      <div className="text-xs leading-5 text-muted-foreground">
        {t("opsSyncSubject")}{" "}
        {status?.google.subject ? (
          <bdi dir="ltr" className="font-mono text-foreground">
            {status.google.subject}
          </bdi>
        ) : (
          <span className="text-foreground">
            {status ? t("asrStatusNotConfigured") : t("opsSyncChecking")}
          </span>
        )}
      </div>
      <div className="rounded-lg border border-line bg-surface-2 p-3 text-xs leading-5 text-muted-foreground">
        <div>
          {t("opsSyncAuth")}{" "}
          <span dir="auto" className="font-medium text-foreground">
            {status?.google.detail ?? t("opsSyncCheckingCredentials")}
          </span>
        </div>
        {status?.google.serviceAccountEmail && (
          <bdi dir="ltr" className="block break-all font-mono">
            {status.google.serviceAccountEmail}
          </bdi>
        )}
        {(!status?.google.configured || status.google.strategy === "missing") && (
          <p className="mt-1 text-warn-text">{t("opsSyncNeedsAccount")}</p>
        )}
      </div>
      {status && !status.google.configured && (
        <Link
          href={`/api/auth/google/start?returnTo=${encodeURIComponent(`/${locale}`)}`}
          className="inline-flex h-9 w-full items-center justify-center rounded-lg bg-brand px-3 text-sm font-medium text-on-brand hover:bg-brand/90"
        >
          {t("opsSyncReconnect")}
        </Link>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          className="h-9 w-full"
          disabled={syncing}
          onClick={onSyncAll}
        >
          <CalendarSyncIcon data-icon="inline-start" />
          {syncing ? t("opsSyncQueued") : t("calendarSync")}
        </Button>
        <Button
          variant="outline"
          className="h-9 w-full"
          disabled={syncing}
          onClick={onSyncMeetArtifacts}
        >
          <RadioTowerIcon data-icon="inline-start" />
          {syncing ? t("opsSyncQueued") : t("opsSyncMeet")}
        </Button>
      </div>

      {/* Job health summary */}
      {status?.jobs && (status.jobs.queued > 0 || status.jobs.active > 0 || status.jobs.failed > 0) && (
        <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs">
          {status.jobs.active > 0 && (
            <span className="flex items-center gap-1 text-brand-text">
              <Loader2Icon aria-hidden="true" className="size-3 animate-spin" />
              {plural("opsDriveActiveJobs", status.jobs.active)}
            </span>
          )}
          {status.jobs.queued > 0 && (
            <span className="flex items-center gap-1 text-muted-foreground">
              <CheckCircle2Icon aria-hidden="true" className="size-3" />
              {plural("opsSyncJobsQueued", status.jobs.queued)}
            </span>
          )}
          {status.jobs.failed > 0 && (
            <span className="flex items-center gap-1 text-destructive">
              <AlertTriangleIcon aria-hidden="true" className="size-3" />
              {plural("opsSyncJobsFailed", status.jobs.failed)}
            </span>
          )}
        </div>
      )}
      <div className="grid gap-2">
        {(status?.sync.length ? status.sync : []).map((item) => (
            <div key={item.source} className="rounded-lg border border-line bg-surface-2 p-3">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium">{label(SOURCE_KEYS, item.source)}</span>
              <span className="text-muted-foreground">{label(SYNC_STATUS_KEYS, item.status)}</span>
            </div>
            {item.stats && Object.keys(item.stats).length > 0 && (
              <p dir="ltr" className="mt-1 text-start text-xs leading-5 text-muted-foreground">
                {Object.entries(item.stats)
                  .filter(([, value]) => typeof value !== "object")
                  .map(([key, value]) => `${key}: ${String(value)}`)
                  .join(" · ")}
              </p>
            )}
            {item.nextPollAt && (
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t("opsSyncNextPoll", { time: fmt.date(item.nextPollAt, "dateTime") })}
              </p>
            )}
            {item.lastError && (
              <p dir="auto" className="mt-1 break-words text-xs leading-5 text-destructive">
                {item.lastError}
              </p>
            )}
          </div>
        ))}
        {!status?.sync.length && (
          <div className="rounded-md border border-dashed p-3 text-xs leading-5 text-muted-foreground">
            {t("opsSyncEmpty")}
          </div>
        )}
      </div>
    </section>
  )
}
