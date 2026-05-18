import {
  AlertTriangleIcon,
  ActivityIcon,
  CheckCircle2Icon,
  FileTextIcon,
  MoreHorizontalIcon,
  NotepadTextIcon,
  SparklesIcon,
} from "lucide-react"

import { GoogleContextCard } from "@/components/google-context-card"
import { PipelineTimeline } from "@/components/pipeline-timeline"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type {
  JobRecord,
  MeetingRecord,
  SuggestedAgentRun,
} from "@/lib/meetings/repository"

function computeConfidence(meeting: MeetingRecord | null) {
  const transcript = meeting?.transcript ?? []
  const actionItems = meeting?.summary?.actionItems ?? []
  const values = [
    ...transcript.map((segment) => segment.confidence).filter(Boolean),
    ...actionItems.map((item) => item.confidence).filter(Boolean),
  ] as number[]

  if (!values.length) return undefined
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function latestAiRun(meeting: MeetingRecord | null, task: string) {
  return meeting?.aiRuns?.find((run) => run.task === task)
}

function formatLatency(value: number | undefined) {
  if (!value) return undefined
  if (value < 1000) return `${value}ms`

  return `${Math.round(value / 100) / 10}s`
}

function tagClass(tag: string) {
  if (/(urgent|follow|review|action|task)/i.test(tag)) {
    return "rounded-sm bg-[var(--tag-action)] text-[var(--tag-action-fg)]"
  }
  if (/(ai|mixed|hebrew|english|portuguese|spanish|italian)/i.test(tag)) {
    return "rounded-sm bg-[var(--tag-ai)] text-[var(--tag-ai-fg)]"
  }
  if (/(technical|product|mcp|gemini|gemma|realizeos)/i.test(tag)) {
    return "rounded-sm bg-[var(--tag-technical)] text-[var(--tag-technical-fg)]"
  }

  return "rounded-sm bg-[var(--tag-business)] text-[var(--tag-business-fg)]"
}

export function MeetingRightRail({
  meeting,
  jobs,
  exporting,
  suggestingAgents,
  onEditTags,
  onExportMarkdown,
  onExportPdf,
  onExportRealizeOS,
  onProcessMeeting,
  onSuggestAgents,
  onApproveAgentRun,
}: {
  meeting: MeetingRecord | null
  jobs: JobRecord[]
  exporting?: boolean
  suggestingAgents?: boolean
  onEditTags: () => void
  onExportMarkdown: () => void
  onExportPdf: () => void
  onExportRealizeOS: () => void
  onProcessMeeting?: () => void
  onSuggestAgents: () => void
  onApproveAgentRun: (run: SuggestedAgentRun) => void
}) {
  const confidence = computeConfidence(meeting)
  const percent = confidence ? Math.round(confidence * 100) : undefined
  const tags = meeting?.tags ?? []
  const suggestedRuns = meeting?.suggestedAgentRuns ?? []
  const transcriptionRun = latestAiRun(meeting, "audio.transcribe")
  const summaryRun = latestAiRun(meeting, "summary.generate")
  const fallbackUsed = transcriptionRun?.metadata.fallbackUsed === true
  const attemptedProvider =
    typeof transcriptionRun?.metadata.attemptedProvider === "string"
      ? transcriptionRun.metadata.attemptedProvider
      : undefined
  const fallbackReason =
    typeof transcriptionRun?.metadata.fallbackReason === "string"
      ? transcriptionRun.metadata.fallbackReason
      : undefined
  const qualityWarnings = meeting?.qualityWarnings ?? []

  return (
    <aside className="ms-scrollbar grid min-h-0 content-start gap-3 overflow-y-auto bg-[var(--rail)] p-3 lg:h-full lg:border-l lg:border-[var(--divider)]">
      <PipelineTimeline meeting={meeting} jobs={jobs} />

      <section className="ms-card p-4">
        <h3 className="mb-4 text-sm font-semibold">AI Confidence</h3>
        {percent ? (
          <div className="flex items-center gap-4">
            <div
              className="grid size-16 place-items-center rounded-full border-[5px] border-emerald-500 text-lg font-semibold"
              aria-label={`AI confidence ${percent}%`}
            >
              {percent}%
            </div>
            <div>
              <div className="font-medium text-[var(--status-success)]">
                {percent >= 80 ? "High" : percent >= 60 ? "Medium" : "Low"}
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Based on transcript and task confidence
              </p>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-[var(--divider)] bg-[var(--surface-subtle)] p-3 text-sm text-muted-foreground">
            Confidence appears after transcription or structured intelligence.
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 h-8 px-0 text-[var(--primary)]"
          disabled
          title={
            percent
              ? "Detailed quality review is coming in the next slice"
              : "Run intelligence first"
          }
        >
          Details
        </Button>
      </section>

      <section className="ms-card p-4">
        <h3 className="mb-3 text-sm font-semibold">Provider run</h3>
        {transcriptionRun || summaryRun ? (
          <div className="grid gap-2">
            {transcriptionRun ? (
              <div className="rounded-md border border-[var(--divider)] bg-[var(--surface-subtle)] p-3">
                <div className="flex items-start gap-2">
                  <ActivityIcon aria-hidden="true" className="mt-0.5 size-4 text-[var(--primary)]" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium">
                      {transcriptionRun.provider}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {transcriptionRun.model ?? "default model"}
                      {formatLatency(transcriptionRun.latencyMs)
                        ? ` · ${formatLatency(transcriptionRun.latencyMs)}`
                        : ""}
                    </p>
                    {fallbackUsed ? (
                      <p className="mt-1 text-xs leading-5 text-[var(--status-warning)]">
                        Fallback used{attemptedProvider ? ` after ${attemptedProvider}` : ""}.
                        {fallbackReason ? ` Reason: ${fallbackReason}` : ""}
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
            {summaryRun ? (
              <div className="rounded-md border border-[var(--divider)] bg-[var(--surface-subtle)] p-3 text-xs leading-5 text-muted-foreground">
                Summary: <span className="font-medium text-foreground">{summaryRun.provider}</span>
                {summaryRun.model ? ` · ${summaryRun.model}` : ""}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-[var(--divider)] bg-[var(--surface-subtle)] p-3 text-sm text-muted-foreground">
            Provider metadata appears after transcription or summarization.
          </div>
        )}
      </section>

      {qualityWarnings.length ? (
        <section className="ms-card p-4">
          <h3 className="mb-3 text-sm font-semibold">Quality review</h3>
          <div className="grid gap-2">
            {qualityWarnings.slice(0, 4).map((warning) => (
              <div
                key={warning.code}
                className="rounded-md border border-[var(--divider)] bg-[var(--surface-subtle)] p-3"
              >
                <div className="flex items-start gap-2">
                  <AlertTriangleIcon
                    aria-hidden="true"
                    className={
                      warning.severity === "warning"
                        ? "mt-0.5 size-4 text-[var(--status-warning)]"
                        : "mt-0.5 size-4 text-[var(--primary)]"
                    }
                  />
                  <div>
                    <div className="text-sm font-medium">{warning.title}</div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {warning.detail}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="ms-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Tags</h3>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[var(--primary)]"
            onClick={onEditTags}
            disabled={!meeting}
          >
            Edit
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {tags.length ? tags.slice(0, 8).map((tag) => (
            <Badge
              key={tag}
              variant="secondary"
              className={tagClass(tag)}
            >
              {tag}
            </Badge>
          )) : (
            <span className="text-sm text-muted-foreground">
              No tags extracted yet.
            </span>
          )}
        </div>
      </section>

      <section className="ms-card p-4">
        <h3 className="mb-3 text-sm font-semibold">Exports & Integrations</h3>
        <div className="grid grid-cols-5 gap-2">
          {[
            {
              Icon: FileTextIcon,
              label: "PDF",
              onClick: onExportPdf,
              enabled: Boolean(meeting),
            },
            {
              Icon: NotepadTextIcon,
              label: "MD",
              onClick: onExportMarkdown,
              enabled: Boolean(meeting),
            },
            {
              Icon: FileTextIcon,
              label: "Notion",
              onClick: undefined,
              enabled: false,
            },
            {
              Icon: NotepadTextIcon,
              label: "RealizeOS",
              onClick: onExportRealizeOS,
              enabled: Boolean(meeting) && !exporting,
            },
          ].map(({ Icon: TypedIcon, label, onClick, enabled }) => (
            <Button
              key={label}
              variant="outline"
              size="icon"
              className="size-9 rounded-md"
              onClick={onClick}
              disabled={!enabled}
              title={enabled ? label : `${label} is not available yet`}
            >
              <TypedIcon aria-hidden="true" className="size-4" />
            </Button>
          ))}
          <Button variant="outline" size="icon" className="size-9 rounded-md" disabled title="More exports coming next">
            <MoreHorizontalIcon aria-hidden="true" className="size-4" />
          </Button>
        </div>
        <div className="mt-2 grid grid-cols-5 gap-2 text-center text-[11px] text-muted-foreground">
          <span>PDF</span>
          <span>MD</span>
          <span>Notion</span>
          <span>RealizeOS</span>
          <span />
        </div>
      </section>

      <section className="ms-card p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Suggested agents</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Approval-gated outputs for follow-up, context, and automations.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={onSuggestAgents}
            disabled={!meeting || suggestingAgents}
          >
            <SparklesIcon aria-hidden="true" className="size-3.5" />
            Suggest
          </Button>
        </div>
        {suggestedRuns.length ? (
          <div className="space-y-2">
            {suggestedRuns.slice(0, 4).map((run) => {
              const title =
                typeof run.payload.title === "string"
                  ? run.payload.title
                  : run.target
              const description =
                typeof run.payload.description === "string"
                  ? run.payload.description
                  : "Approval required before this agent can affect external systems."
              const canApprove = run.status === "suggested"

              return (
                <div
                  key={run.id}
                  className="rounded-md border border-[var(--divider)] bg-[var(--surface-subtle)] p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{title}</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {description}
                      </p>
                    </div>
                    <Badge variant="secondary" className="rounded-sm">
                      {run.status}
                    </Badge>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2 h-8 w-full gap-1.5"
                    onClick={() => onApproveAgentRun(run)}
                    disabled={!canApprove}
                    title={
                      canApprove
                        ? "Approve this suggested agent run"
                        : "This suggestion has already moved forward"
                    }
                  >
                    <CheckCircle2Icon aria-hidden="true" className="size-3.5" />
                    Approve
                  </Button>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-[var(--divider)] bg-[var(--surface-subtle)] p-3 text-sm text-muted-foreground">
            Suggestions appear after a meeting has transcript or summary content.
          </div>
        )}
      </section>

      <GoogleContextCard
        meeting={meeting}
        onProcessMeeting={onProcessMeeting}
      />
    </aside>
  )
}
