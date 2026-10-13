"use client"

import type { ReactNode } from "react"
import {
  AlertTriangleIcon,
  ActivityIcon,
  CheckCircle2Icon,
  NotepadTextIcon,
} from "lucide-react"

import { GoogleContextCard } from "@/components/google-context-card"
import { useI18n } from "@/components/i18n-provider"
import { MeetingExportMenu } from "@/components/meetings/meeting-export-menu"
import { PipelineTimeline } from "@/components/pipeline-timeline"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CitedMark } from "@/components/ui/meeting-atoms"
import { AGENT_INTENT_KEYS } from "@/lib/agents/intent-messages"
import type {
  JobRecord,
  MeetingQualityWarning,
  MeetingRecord,
  SuggestedAgentRun,
} from "@/lib/meetings/repository"

type I18n = ReturnType<typeof useI18n>

const AGENT_STATUS_KEYS: Record<SuggestedAgentRun["status"], string> = {
  suggested: "mtgAgentStatusSuggested",
  queued: "mtgAgentStatusQueued",
  sent: "mtgAgentStatusSent",
  failed: "mtgAgentStatusFailed",
}

/** Quality warning copy by code and params (lib/meetings/quality returns codes only). */
function qualityWarningText(
  warning: MeetingQualityWarning,
  meeting: MeetingRecord | null,
  provider: string | undefined,
  { t, plural }: I18n
): { title: string; detail: string } {
  switch (warning.code) {
    case "smart_notes_only":
      return { title: t("mtgQualitySmartNotesOnlyTitle"), detail: t("mtgQualitySmartNotesOnlyDetail") }
    case "transcription_fallback":
      return {
        title: t("mtgQualityFallbackTitle"),
        detail: t("mtgQualityFallbackDetail", { provider: warning.params?.provider ?? provider ?? "—" }),
      }
    case "weak_transcript_confidence":
      return { title: t("mtgQualityWeakConfidenceTitle"), detail: t("mtgQualityWeakConfidenceDetail") }
    case "no_speaker_diarization":
      return { title: t("mtgQualityGenericSpeakersTitle"), detail: t("mtgQualityGenericSpeakersDetail") }
    case "summary_language_mismatch":
      return { title: t("mtgQualityLanguageMismatchTitle"), detail: t("mtgQualityLanguageMismatchDetail") }
    case "task_missing_owner_or_due_date": {
      const count =
        typeof warning.params?.count === "number"
          ? warning.params.count
          : (meeting?.summary?.actionItems ?? []).filter(
              (item) => item.status !== "done" && (!item.owner || !item.dueDate)
            ).length

      return {
        title: t("mtgQualityTasksIncompleteTitle"),
        detail: plural("mtgQualityTasksIncompleteDetail", count),
      }
    }
    default:
      return { title: String(warning.code), detail: "" }
  }
}

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

function formatLatency(value: number | undefined, { t, fmt }: I18n) {
  if (!value) return undefined
  if (value < 1000) return t("mtgRailLatencyMs", { value: fmt.number(value) })

  return t("mtgRailLatencySeconds", { value: fmt.number(Math.round(value / 100) / 10) })
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
  const i18n = useI18n()
  const { t, fmt, text } = i18n
  const confidence = computeConfidence(meeting)
  const percent = confidence ? Math.round(confidence * 100) : undefined
  const percentLabel = confidence ? fmt.percent(confidence) : ""
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
  const latency = formatLatency(transcriptionRun?.latencyMs, i18n)

  return (
    <aside className="ms-scrollbar grid min-h-0 content-start gap-3 overflow-y-auto bg-surface-2 p-3 lg:col-span-2 lg:grid-cols-2 lg:border-t lg:border-line 2xl:col-span-1 2xl:grid-cols-1 2xl:h-full 2xl:border-s 2xl:border-t-0">
      <PipelineTimeline meeting={meeting} jobs={jobs} />

      {talkTime ? <section className="ms-card p-4">{talkTime}</section> : null}

      {analytics}

      <section className="ms-card p-4">
        <h3 className="mb-4 text-sm font-semibold">{t("mtgRailConfidenceTitle")}</h3>
        {percent ? (
          <div className="flex items-center gap-4">
            <div
              role="img"
              className="grid size-16 place-items-center rounded-full border-4 border-ok text-lg font-semibold [direction:ltr] [unicode-bidi:isolate]"
              aria-label={t("mtgRailConfidenceAria", { percent: percentLabel })}
            >
              {percentLabel}
            </div>
            <div>
              <div className="font-medium text-ok-text">
                {percent >= 80
                  ? t("mtgRailConfidenceHigh")
                  : percent >= 60
                    ? t("mtgRailConfidenceMedium")
                    : t("mtgRailConfidenceLow")}
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t("mtgRailConfidenceBasis")}
              </p>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-line bg-surface-2 p-3 text-sm text-muted-foreground">
            {t("mtgRailConfidenceEmpty")}
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 h-8 px-0 text-brand-text"
          disabled
          title={percent ? t("mtgRailDetailsSoon") : t("mtgRailRunIntelligenceFirst")}
        >
          {t("mtgRailDetails")}
        </Button>
      </section>

      <section className="ms-card p-4">
        <h3 className="mb-3 text-sm font-semibold">{t("mtgRailProviderRun")}</h3>
        {transcriptionRun || summaryRun ? (
          <div className="grid gap-2">
            {transcriptionRun ? (
              <div className="rounded-md border border-line bg-surface-2 p-3">
                <div className="flex items-start gap-2">
                  <ActivityIcon aria-hidden="true" className="mt-0.5 size-4 text-brand-text" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium">
                      <bdi>{transcriptionRun.provider}</bdi>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {transcriptionRun.model ? <bdi>{transcriptionRun.model}</bdi> : t("mtgRailDefaultModel")}
                      {latency ? ` · ${latency}` : ""}
                    </p>
                    {fallbackUsed ? (
                      <p className="mt-1 text-xs leading-5 text-warn-text">
                        {attemptedProvider
                          ? t("mtgRailFallbackUsedAfter", { provider: attemptedProvider })
                          : t("mtgRailFallbackUsed")}
                        {fallbackReason ? <> {t("mtgRailFallbackReason", { reason: fallbackReason })}</> : null}
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
            {summaryRun ? (
              <div className="rounded-md border border-line bg-surface-2 p-3 text-xs leading-5 text-muted-foreground">
                {t("mtgRailSummaryProvider")}{" "}
                <bdi className="font-medium text-foreground">{summaryRun.provider}</bdi>
                {summaryRun.model ? <> · <bdi>{summaryRun.model}</bdi></> : null}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-line bg-surface-2 p-3 text-sm text-muted-foreground">
            {t("mtgRailProviderEmpty")}
          </div>
        )}
      </section>

      {qualityWarnings.length ? (
        <section className="ms-card p-4">
          <h3 className="mb-3 text-sm font-semibold">{t("mtgRailQualityReview")}</h3>
          <div className="grid gap-2">
            {qualityWarnings.slice(0, 4).map((warning) => {
              const copy = qualityWarningText(warning, meeting, transcriptionRun?.provider, i18n)

              return (
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
                      <div className="text-sm font-medium">{copy.title}</div>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {copy.detail}
                      </p>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ) : null}

      <section className="ms-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t("tags")}</h3>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-brand-text"
            onClick={onEditTags}
            disabled={!meeting}
          >
            {t("mtgRailEditTags")}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {tags.length ? tags.slice(0, 8).map((tag) => (
            <Badge
              key={tag}
              variant="secondary"
              className={tagClass(tag)}
            >
              <bdi>{tag}</bdi>
            </Badge>
          )) : (
            <span className="text-sm text-muted-foreground">
              {t("mtgRailNoTags")}
            </span>
          )}
        </div>
      </section>

      <section className="ms-card p-4">
        <h3 className="mb-3 text-sm font-semibold">{t("mtgRailExports")}</h3>
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
            <h3 className="text-sm font-semibold">{t("mtgRailAgentsTitle")}</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t("mtgRailAgentsHint")}
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
            {t("mtgRailAgentsSuggest")}
          </Button>
        </div>
        {suggestedRuns.length ? (
          <div className="space-y-2">
            {suggestedRuns.slice(0, 4).map((run) => {
              const intentKeys =
                typeof run.payload.intent === "string" ? AGENT_INTENT_KEYS[run.payload.intent] : undefined
              const title = intentKeys
                ? t(intentKeys.title)
                : typeof run.payload.title === "string"
                  ? text(run.payload.title)
                  : run.target
              const description = intentKeys
                ? t(intentKeys.description)
                : typeof run.payload.description === "string"
                  ? text(run.payload.description)
                  : t("mtgRailAgentApprovalRequired")
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
                      {AGENT_STATUS_KEYS[run.status] ? t(AGENT_STATUS_KEYS[run.status]) : run.status}
                    </Badge>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2 h-8 w-full gap-1.5"
                    onClick={() => onApproveAgentRun(run)}
                    disabled={!canApprove}
                    title={canApprove ? t("mtgRailAgentApproveHint") : t("mtgRailAgentAlreadyMoved")}
                  >
                    <CheckCircle2Icon aria-hidden="true" className="size-3.5" />
                    {t("mtgRailAgentApprove")}
                  </Button>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-line bg-surface-2 p-3 text-sm text-muted-foreground">
            {t("mtgRailAgentsEmpty")}
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
