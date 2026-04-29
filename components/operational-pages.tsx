import {
  BotIcon,
  CloudIcon,
  DatabaseIcon,
  FileAudioIcon,
  KeyRoundIcon,
  LinkIcon,
  RadioTowerIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  WorkflowIcon,
} from "lucide-react"
import type { ReactNode } from "react"

import { JobActivityCenter } from "@/components/job-activity-center"
import { ProviderHealthPanel, type ProviderStatusView } from "@/components/provider-health-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { WorkspaceSyncPanel, type WorkspaceStatusView } from "@/components/workspace-sync-panel"
import type { MainPanelKey } from "@/components/main-sidebar"
import type { JobRecord, MeetingRecord } from "@/lib/meetings/repository"

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
    <div className="min-h-[calc(100svh-4rem)] bg-[var(--surface-subtle)] p-4 lg:p-6">
      <div className="mx-auto grid max-w-7xl gap-5">
        <header className="rounded-md border border-[var(--divider)] bg-[var(--surface)] p-5 shadow-[0_1px_0_rgba(15,23,42,0.02)]">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--primary)]">
            {eyebrow}
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            {description}
          </p>
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
    <section className="rounded-md border border-[var(--divider)] bg-[var(--surface)] p-4 shadow-[0_1px_0_rgba(15,23,42,0.02)]">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="grid size-9 place-items-center rounded-md bg-[var(--selected)] text-[var(--primary)]">
            <Icon aria-hidden="true" className="size-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground">{title}</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
          </div>
        </div>
        {status && (
          <Badge className="rounded-sm bg-[var(--selected)] text-[var(--primary)]">{status}</Badge>
        )}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </section>
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
}) {
  if (panel === "workspace") {
    return (
      <PageFrame
        eyebrow="Google-first intake"
        title="Workspace command center"
        description="Calendar creates schedule context, Drive imports are operator-selected, and Meet artifacts are the preferred live-meeting capture path."
      >
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
          <WorkspaceSyncPanel
            status={workspaceStatus}
            syncing={syncing}
            onSyncAll={onSyncCalendar}
          />
          <div className="grid gap-4">
            <OpsCard
              icon={RadioTowerIcon}
              title="Live meeting capture"
              description="V1 uses native Google Meet recordings, transcripts, and smart notes. MeetSum imports artifacts after the meeting and does not join as a bot yet."
              status="Google artifacts first"
            >
              <div className="grid gap-2 text-sm text-muted-foreground">
                <div className="flex items-center justify-between rounded-md border bg-[var(--surface-subtle)] p-2">
                  <span>Recording / transcript / smart notes readiness</span>
                  <Badge variant="outline" className="rounded-sm">checklist</Badge>
                </div>
                <Button className="h-10 w-full" variant="outline" onClick={onFindDriveRecordings}>
                  <FileAudioIcon data-icon="inline-start" className="size-4" />
                  Find Drive recordings
                </Button>
              </div>
            </OpsCard>
            <ProviderHealthPanel providers={providers} />
          </div>
          <div className="xl:col-span-2">
            <JobActivityCenter jobs={jobs} onRetry={onRetryJob} />
          </div>
        </div>
      </PageFrame>
    )
  }

  if (panel === "memory") {
    const completed = meetings.filter((meeting) => meeting.summary?.overview)

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
            <div className="mt-3 grid gap-2">
              {completed.slice(0, 6).map((meeting) => (
                <div key={meeting.id} className="rounded-md border bg-[var(--surface-subtle)] p-3">
                  <div className="text-sm font-semibold text-foreground">{meeting.title}</div>
                  <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">
                    {meeting.summary?.overview}
                  </p>
                </div>
              ))}
            </div>
          </OpsCard>
          <OpsCard
            icon={SparklesIcon}
            title="Ask all meetings"
            description="The API surface is ready at /api/memory/ask; the next UI pass will stream answers with citations."
            status={`${completed.length} indexed`}
          />
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
        <div className="grid gap-4 lg:grid-cols-3">
          <OpsCard icon={WorkflowIcon} title="Webhooks" description="meeting.completed, summary.created, and action_item.created delivery infrastructure." status="ready" />
          <OpsCard icon={BotIcon} title="RealizeOS" description="Structured meeting exports with audit records and retryable jobs." status="connected" />
          <OpsCard icon={LinkIcon} title="n8n" description="Endpoint-ready, no required live workflow yet." status="prepared" />
        </div>
        <JobActivityCenter jobs={jobs} onRetry={onRetryJob} />
      </PageFrame>
    )
  }

  if (panel === "storage") {
    const assets = meetings.reduce((sum, meeting) => sum + (meeting.mediaAssets?.length ?? 0), 0)

    return (
      <PageFrame
        eyebrow="Retention and backups"
        title="Storage operations"
        description="Audio is retained for 180 days by default, transcripts and summaries are retained indefinitely, and raw video is not kept unless explicitly enabled."
      >
        <div className="grid gap-4 lg:grid-cols-3">
          <OpsCard icon={DatabaseIcon} title="Media assets" description="Imported audio/video-derived assets stored privately in MinIO." status={`${assets} assets`} />
          <OpsCard icon={ShieldCheckIcon} title="Retention policy" description="Audio-first by default. Video retained only when configured." status="active" />
          <OpsCard icon={CloudIcon} title="Backups" description="Postgres backup runs before VPS deploys; restore remains operator-confirmed." status="configured" />
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
      <div className="grid gap-4 lg:grid-cols-2">
        <OpsCard icon={KeyRoundIcon} title="Account and access" description="Primary admin: info@realization.co.il. Google login remains the preferred browser auth path." status="Google OAuth" />
        <OpsCard icon={SparklesIcon} title="AI provider" description="AI Studio Gemini remains active. Vertex AI credential path is prepared but not switched until smoke-tested." status="Gemini" />
        <OpsCard icon={RadioTowerIcon} title="Live capture preference" description="Google artifacts first; Meet bot deferred until Developer Preview and consent requirements are stable." status="V1" />
        <OpsCard icon={ShieldCheckIcon} title="Security" description="API keys for machine access, signed webhooks, private secrets on VPS only." status="hardened" />
      </div>
    </PageFrame>
  )
}
