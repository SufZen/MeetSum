import type { ReactNode } from "react"
import {
  AlertTriangleIcon,
  ActivityIcon,
  CheckCircle2Icon,
  NotepadTextIcon,
} from "lucide-react"

import { GoogleContextCard } from "@/components/google-context-card"
import { MeetingExportMenu } from "@/components/meetings/meeting-export-menu"
import { PipelineTimeline } from "@/components/pipeline-timeline"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CitedMark } from "@/components/ui/meeting-atoms"
import type {
  JobRecord,
  MeetingRecord,
  SuggestedAgentRun,
} from "@/lib/meetings/repository"

function latestAiRun(meeting: MeetingRecord | null, task: string) {
  return meeting?.aiRuns?.find((run) => run.task === task)
}

/**
 * Confidence of the transcription run (M4: the detail no longer carries the
 * transcript); falls back to task confidences when the run has none.
 */
function computeConfidence(meeting: MeetingRecord | null) {
  const runConfidence = latestAiRun(meeting, "audio.transcribe")?.confidence

  if (typeof runConfidence === "number" && Number.isFinite(runConfidence)) return runConfidence

  const values = (meeting?.summary?.actionItems ?? [])
    .map((item) => item.confidence)
    .filter((value): value is number => typeof value === "number" && value > 0)

  if (!values.length) return undefined
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function formatLatency(value: number | undefined) {
  if (!value) return undefined
  if (value < 1000) return `${value}ms`

  return `${Math.round(value / 100) / 10}s`
}

function tagClass(tag: string) {
  if (/(urgent|follow|review|action|task)/i.test(tag)) {
    return "rounded-sm bg-warn-soft text-warn-text"
  }
  if (/(ai|mixed|hebrew|english|portuguese|spanish|italian)/i.test(tag)) {
    return "rounded-sm bg-surface-3 text-fg-2"
  }
  if (/(technical|product|mcp|gemini|gemma|realizeos)/i.test(tag)) {
    return "rounded-sm bg-info-soft text-info-text"
  }

  return "rounded-sm bg-brand-soft text-brand-text"
}

export function MeetingRightRail({
  meeting,
  jobs,
  exporting,
  suggestingAgents,
  onEditTags,
  canManage = false,
  onExportRealizeOS,
  onProcessMeeting,
  onSuggestAgents,
  onApproveAgentRun,
  talkTime,
  analytics,
}: {
  meeting: MeetingRecord | null
  jobs: JobRecord[]
  exporting?: boolean
  suggestingAgents?: boolean
  onEditTags: () => void
  /** `canManageMeeting` for the selected meeting (export menu, M8). */
  canManage?: boolean
  onExportRealizeOS: () => void
  onProcessMeeting?: () => void
  onSuggestAgents: () => void
  onApproveAgentRun: (run: SuggestedAgentRun) => void
  /** Talk-time panel (2xl rail). */
  talkTime?: ReactNode
  /** M5 conversation analytics card. */
  analytics?: ReactNode
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
    <aside className="ms-scrollbar grid min-h-0 content-start gap-3 overflow-y-auto bg-surface-2 p-3 lg:col-span-2 lg:grid-cols-2 lg:border-t lg:border-line 2xl:col-span-1 2xl:grid-cols-1 2xl:h-full 2xl:border-s 2xl:border-t-0">
      <PipelineTimeline meeting={meeting} jobs={jobs} />

      {talkTime ? <section className="ms-card p-4">{talkTime}</section> : null}

      {analytics}

      <section className="ms-card p-4">
        <h3 className="mb-4 text-sm font-semibold">AI Confidence</h3>
        {percent ? (
          <div className="flex items-center gap-4">
            <div
              className="grid size-16 place-items-center rounded-full border-4 border-ok text-lg font-semibold"
              aria-label={`AI confidence ${percent}%`}
            >
              {percent}%
            </div>
            <div>
              <div className="font-medium text-ok-text">
                {percent >= 80 ? "High" : percent >= 60 ? "Medium" : "Low"}
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Based on the transcription run
              </p>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-line bg-surface-2 p-3 text-sm text-muted-foreground">
            Confidence appears after transcription or structured intelligence.
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 h-8 px-0 text-brand-text"
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
              <div className="rounded-md border border-line bg-surface-2 p-3">
                <div className="flex items-start gap-2">
                  <ActivityIcon aria-hidden="true" className="mt-0.5 size-4 text-brand-text" />
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
                      <p className="mt-1 text-xs leading-5 text-warn-text">
                        Fallback used{attemptedProvider ? ` after ${attemptedProvider}` : ""}.
                        {fallbackReason ? ` Reason: ${fallbackReason}` : ""}
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
            {summaryRun ? (
              <div className="rounded-md border border-line bg-surface-2 p-3 text-xs leading-5 text-muted-foreground">
                Summary: <span className="font-medium text-foreground">{summaryRun.provider}</span>
                {summaryRun.model ? ` · ${summaryRun.model}` : ""}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-line bg-surface-2 p-3 text-sm text-muted-foreground">
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
                className="rounded-md border border-line bg-surface-2 p-3"
              >
                <div className="flex items-start gap-2">
                  <AlertTriangleIcon
                    aria-hidden="true"
                    className={
                      warning.severity === "warning"
                        ? "mt-0.5 size-4 text-warn-text"
                        : "mt-0.5 size-4 text-brand-text"
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
            className="h-7 text-brand-text"
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
        {/* M8 C3: Download (PDF, Markdown, DOCX), Google Docs and Send to… live in one menu. */}
        <div className="flex flex-wrap items-center gap-2">
          <MeetingExportMenu
            meetingId={meeting?.id}
            title={meeting?.title ?? ""}
            language={meeting?.language ?? ""}
            visibility={meeting?.visibility}
            canManage={canManage}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5"
            onClick={onExportRealizeOS}
            disabled={!meeting || exporting}
          >
            <NotepadTextIcon aria-hidden="true" className="size-4" />
            RealizeOS
          </Button>
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
            variant="ai"
            size="sm"
            className="gap-1.5"
            onClick={onSuggestAgents}
            disabled={!meeting || suggestingAgents}
          >
            <CitedMark className="size-3.5" />
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
                  className="rounded-md border border-line bg-surface-2 p-3"
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
          <div className="rounded-md border border-dashed border-line bg-surface-2 p-3 text-sm text-muted-foreground">
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
