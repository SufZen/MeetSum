"use client"

/**
 * Summary tab (M5 D7, Cadence §7 and §10). Order: Overview → Action items →
 * Decisions → Open questions → template sections, risks and next steps →
 * Chapters. Model-written lines carry a provenance hairline in the colours
 * of the speakers they cite and citation chips only for refs that resolve to
 * real segments; edited items are the user's. Paragraph direction comes from
 * the meeting's primary language, never `auto`.
 */
import { useMemo, useState, type ReactNode } from "react"
import {
  AlertTriangleIcon,
  CopyIcon,
  FileAudioIcon,
  PlayCircleIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  UploadIcon,
} from "lucide-react"

import {
  readinessCheckLabel,
  readinessCheckState,
  readinessText,
} from "@/components/google-context-card"
import { useI18n } from "@/components/i18n-provider"
import { ChapterList } from "@/components/intelligence/chapter-list"
import {
  SummaryLine,
  useCitationColors,
  useResolvedRefs,
} from "@/components/intelligence/summary-line"
import { TemplatePicker } from "@/components/intelligence/template-picker"
import { requestJson } from "@/components/intelligence/use-json"
import { PlayerCitation } from "@/components/player/player-citation"
import type { SpeakerDirectory } from "@/components/player/speaker-directory"
import { directionForLanguage } from "@/components/speaker-display"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { AiProvenance } from "@/components/ui/meeting-atoms"
import { summaryProvenance } from "@/lib/intelligence/provenance"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { formatMessage, type Dictionary } from "@/lib/i18n/dictionaries"
import type { SummaryItem, SummaryItemKind, SummaryItemRef } from "@/lib/intelligence"
import { normalizeIntelligence } from "@/lib/intelligence/normalize"
import { getMeetingCaptureReadiness } from "@/lib/meetings/capture-readiness"
import { formatTimestamp } from "@/lib/meetings/duration"
import type { ActionItem, JobRecord, MeetingRecord } from "@/lib/meetings/repository"
import { getMeetingWorkStatus, type MeetingWorkStatus } from "@/lib/meetings/work-status"

type Translate = ReturnType<typeof useI18n>["t"]

const PRIORITY_KEYS: Record<NonNullable<ActionItem["priority"]>, keyof Dictionary> = {
  low: "tasksPriorityLow",
  normal: "tasksPriorityNormal",
  high: "tasksPriorityHigh",
  urgent: "tasksPriorityUrgent",
}

const STAGE_KEYS: Record<string, string> = {
  "artifact.import": "mtgStageArtifactImport",
  "drive.import": "mtgStageDriveImport",
  "audio.extract": "mtgStageAudioExtract",
  "audio.transcribe": "mtgStageTranscribe",
  transcribing: "mtgStageTranscribe",
  "transcript.clean": "mtgStageTranscriptClean",
  "summary.generate": "mtgStageSummary",
  summarizing: "mtgStageSummary",
  "summary.persist": "mtgStageSummaryPersist",
  "tasks.extract": "mtgStageTasks",
  "meeting.index": "mtgStageIndex",
  indexing: "mtgStageIndex",
  "quality.review": "mtgStageQuality",
  completed: "mtgStageCompleted",
}

/**
 * Localized title and description of a work status (lib/meetings/work-status
 * returns codes only: kind, stage, job status and action).
 */
function workStatusText(
  status: MeetingWorkStatus,
  meeting: MeetingRecord,
  job: JobRecord | undefined,
  t: Translate,
  locale: string
): { title: string; description: string } {
  if (status.kind === "processing") {
    const title = status.stage && STAGE_KEYS[status.stage] ? t(STAGE_KEYS[status.stage]!) : t("mtgWorkProcessingTitle")

    return {
      title,
      description: t(job?.status === "active" ? "mtgWorkProcessingActive" : "mtgWorkProcessingQueued", { stage: title }),
    }
  }
  if (status.kind === "failed") {
    return {
      title: t("mtgWorkFailedTitle"),
      // The job error is server text: shown in English only.
      description: locale === "en" && job?.error ? job.error : t("mtgWorkFailedDescription"),
    }
  }

  return readinessText(getMeetingCaptureReadiness(meeting), meeting.source, t)
}

/** `YYYY-MM-DD` / ISO → `DD.MM.YYYY` (Hebrew business format). */
function dueLabel(item: ActionItem): string | undefined {
  const value = item.dueOn ?? item.dueDate
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null

  return match ? `${match[3]}.${match[2]}.${match[1]}` : undefined
}

function priorityClass(priority?: ActionItem["priority"]) {
  if (priority === "urgent" || priority === "high") return "bg-warn-soft text-warn-text"
  if (priority === "low") return "bg-surface-3 text-fg-2"

  return "bg-surface-3 text-fg-2"
}

function readinessBadgeClass(status: ReturnType<typeof getMeetingCaptureReadiness>["status"]) {
  if (status === "ready_to_process" || status === "processed") {
    return "border-ok/40 bg-brand-soft text-brand-text"
  }
  if (status === "capture_armed") {
    return "border-brand/30 bg-brand-soft text-brand-text"
  }

  return "border-warn/40 bg-warn-soft text-warn-text"
}

function checkDotClass(state: "ready" | "pending" | "missing") {
  if (state === "ready") return "bg-ok"
  if (state === "missing") return "bg-danger"

  return "bg-fg-3/40"
}

function actionItemRefs(item: ActionItem): SummaryItemRef[] {
  return item.sourceStartMs === undefined && !item.sourceSegmentId
    ? []
    : [{ segmentId: item.sourceSegmentId ?? "", startMs: item.sourceStartMs ?? 0 }]
}

function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      {action}
    </div>
  )
}

function CopyButton({ label, text, onCopy }: { label: string; text: string; onCopy: (text: string, label: string) => void }) {
  return (
    <Button variant="ghost" size="sm" className="h-8 text-muted-foreground" onClick={() => onCopy(text, label)}>
      <CopyIcon data-icon="inline-start" className="size-4" />
      {label}
    </Button>
  )
}

type RegenerateLanguage = "" | "he" | "en"

export function MeetingSummaryView({
  dictionary,
  meeting,
  jobs,
  onToggleActionItem,
  onReprocessMeeting,
  onProcessMeeting,
  onRetryJob,
  onOpenUpload,
  onFindDriveRecordings,
  onSyncMeetArtifacts,
  onCopyText,
  talkTime,
  directory,
  locale,
  canWrite = false,
  onRegenerated,
  onTemplateChanged,
}: {
  dictionary: Dictionary
  meeting: MeetingRecord
  jobs: JobRecord[]
  onToggleActionItem: (item: ActionItem) => void
  onReprocessMeeting: (mode: "full" | "summary" | "tasks" | "transcript-cleanup") => void
  onProcessMeeting: () => void
  onRetryJob: (job: JobRecord) => void
  onOpenUpload: () => void
  onFindDriveRecordings: () => void
  onSyncMeetArtifacts: () => void
  onCopyText: (text: string, label: string) => void
  /** Talk-time panel slot (shown after the chapters). */
  talkTime?: ReactNode
  /** Speaker colours for provenance hairlines. */
  directory?: SpeakerDirectory
  locale?: string
  /** `meeting:write`: template picker and Regenerate. */
  canWrite?: boolean
  /** A regeneration was queued (refresh jobs). */
  onRegenerated?: () => void
  onTemplateChanged?: (templateKey: string | null) => void
}) {
  const t = dictionary
  const { t: tr, plural, fmt, text, locale: uiLocale } = useI18n()
  const intelligence = useMemo(
    () => (meeting.intelligence ? normalizeIntelligence(meeting.intelligence) : undefined),
    [meeting.intelligence]
  )
  const items = useMemo(() => intelligence?.items ?? [], [intelligence])
  const byKind = (kind: SummaryItemKind) => items.filter((item) => item.kind === kind)
  const actionItems = meeting.summary?.actionItems ?? intelligence?.actionItems ?? []
  const quotes = intelligence?.timestampedQuotes ?? []
  const generation = intelligence?.generation
  const summaryLanguage =
    generation?.language ?? intelligence?.languageMetadata.primaryLanguage ?? meeting.language
  const dir = directionForLanguage(summaryLanguage) ?? "rtl"
  const meetingDir = directionForLanguage(meeting.languageMetadata?.primaryLanguage ?? meeting.language) ?? dir
  const allRefs = useMemo(() => items.flatMap((item) => item.refs), [items])
  const moments = useResolvedRefs(allRefs)
  const sourceColors = useCitationColors(moments, directory)
  const [regenerateLanguage, setRegenerateLanguage] = useState<RegenerateLanguage>("")
  const [templateKey, setTemplateKey] = useState<string | null>(meeting.templateKey ?? null)
  const [regenerateState, setRegenerateState] = useState<"idle" | "busy" | "queued" | "failed">("idle")

  const isUpcoming = meeting.status === "scheduled" && !meeting.summary
  const hasMedia = Boolean(meeting.mediaAssets?.some((asset) => asset.storageKey))
  const hasTranscript = (meeting.transcriptSegmentCount ?? meeting.transcript?.length ?? 0) > 0
  const hasMeetImportableArtifact = meeting.meetConferenceRecords?.some((record) =>
    record.artifacts.some((artifact) =>
      ["transcript", "smart_notes", "recording"].includes(artifact.artifactType)
    )
  )
  const canFullReprocess = hasMedia || hasMeetImportableArtifact
  const canProcess = hasMedia || hasTranscript || hasMeetImportableArtifact
  const overview = meeting.summary?.overview ?? intelligence?.overview
  const showContentGap = !overview
  const readiness = getMeetingCaptureReadiness(meeting)
  const workStatus = getMeetingWorkStatus(meeting, jobs)
  const latestJob = workStatus.jobId ? jobs.find((job) => job.id === workStatus.jobId) : undefined
  const workCopy = workStatusText(workStatus, meeting, latestJob, tr, uiLocale)
  const showWorkStatus = workStatus.kind === "processing" || workStatus.kind === "failed"
  const languageMismatch = generation?.languageCheck === "failed"
  // Iris AI mark only for AI content (not heuristic / fallback summaries).
  const provenance = summaryProvenance(generation)
  const generatedAt = generation?.generatedAt ? fmt.date(generation.generatedAt, "dateTime") || undefined : undefined
  const languageName = (code: string) =>
    code === "he" ? t.intelLanguageHe : code === "en" ? t.intelLanguageEn : code

  async function regenerate() {
    setRegenerateState("busy")
    try {
      await requestJson(`/api/meetings/${encodeURIComponent(meeting.id)}/intelligence/run`, {
        method: "POST",
        body: {
          ...(templateKey ? { templateKey } : {}),
          ...(regenerateLanguage ? { language: regenerateLanguage } : {}),
        },
      })
      setRegenerateState("queued")
      onRegenerated?.()
    } catch {
      setRegenerateState("failed")
    }
  }

  const itemList = (list: SummaryItem[]) =>
    list.length ? (
      <ul className="grid gap-0.5">
        {list.map((item) => (
          <SummaryLine
            key={item.id}
            id={item.id}
            text={item.text}
            refs={item.refs}
            dir={dir}
            meetingId={meeting.id}
            dictionary={t}
            directory={directory}
          />
        ))}
      </ul>
    ) : (
      <p className="text-sm text-fg-3">{t.intelNoItems}</p>
    )

  const decisions = byKind("decision")
  const questions = byKind("open_question")
  const risks = byKind("risk")
  const nextSteps = byKind("next_step")
  const commitments = byKind("commitment")
  const sections = intelligence?.sections ?? []
  const chapters = intelligence?.chapters ?? []

  return (
    <div className="px-5 py-6 md:px-8">
      <div className="mx-auto max-w-3xl">
        {showWorkStatus ? (
          <section
            className={`mb-5 rounded-lg border p-4 text-sm leading-6 ${
              workStatus.kind === "failed"
                ? "border-danger/40 bg-warn-soft text-warn-text"
                : "border-brand/30 bg-brand-soft text-brand-text"
            }`}
          >
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="font-semibold">{workCopy.title}</div>
                <p className="mt-1 opacity-90">{workCopy.description}</p>
                {workStatus.stage ? (
                  <div dir="ltr" className="mt-2 font-mono text-xs opacity-80 [unicode-bidi:isolate]">
                    {workStatus.stage}
                    {workStatus.jobId ? ` · ${workStatus.jobId}` : ""}
                  </div>
                ) : null}
              </div>
              {workStatus.primaryAction === "retry" && latestJob ? (
                <Button size="sm" variant="outline" onClick={() => onRetryJob(latestJob)}>
                  <RefreshCwIcon data-icon="inline-start" className="size-4" />
                  {tr("mtgSummaryRetryJob")}
                </Button>
              ) : null}
            </div>
            {workStatus.kind === "processing" && typeof workStatus.progress === "number" ? (
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface/70">
                <div
                  className="h-full rounded-full bg-brand"
                  style={{ width: `${Math.round(workStatus.progress * 100)}%` }}
                />
              </div>
            ) : null}
          </section>
        ) : null}

        {/* Overview */}
        <section>
          <SectionHeader
            title={t.overview}
            action={
              <div className="flex flex-wrap items-center justify-end gap-2">
                {canWrite ? (
                  <>
                    <TemplatePicker
                      meetingId={meeting.id}
                      value={templateKey}
                      dictionary={t}
                      locale={locale}
                      onChange={(key) => {
                        setTemplateKey(key)
                        onTemplateChanged?.(key)
                      }}
                    />
                    <NativeSelect
                      size="sm"
                      aria-label={t.intelLanguage}
                      value={regenerateLanguage}
                      onChange={(event) => setRegenerateLanguage(event.target.value as RegenerateLanguage)}
                    >
                      <NativeSelectOption value="">{t.intelLanguageAuto}</NativeSelectOption>
                      <NativeSelectOption value="he">{t.intelLanguageHe}</NativeSelectOption>
                      <NativeSelectOption value="en">{t.intelLanguageEn}</NativeSelectOption>
                    </NativeSelect>
                    <Button
                      variant="ai"
                      size="sm"
                      disabled={!hasTranscript || regenerateState === "busy"}
                      onClick={() => void regenerate()}
                    >
                      <RefreshCwIcon data-icon="inline-start" className="size-4" />
                      {regenerateState === "busy" ? t.intelRegenerating : t.intelRegenerate}
                    </Button>
                  </>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={!canFullReprocess}
                  onClick={() => onReprocessMeeting("full")}
                >
                  <RefreshCwIcon data-icon="inline-start" className="size-4" />
                  {hasMeetImportableArtifact && !hasMedia ? tr("mtgSummaryProcessFromGoogle") : tr("mtgSummaryReprocess")}
                </Button>
                {overview ? <CopyButton label={t.intelCopy} text={overview} onCopy={onCopyText} /> : null}
              </div>
            }
          />
          {regenerateState === "queued" || regenerateState === "failed" ? (
            <p role="status" className={`mb-2 text-xs ${regenerateState === "failed" ? "text-danger-text" : "text-fg-3"}`}>
              {regenerateState === "failed" ? t.intelRegenerateFailed : t.intelRegenerateQueued}
            </p>
          ) : null}
          {showContentGap ? (
            <div className="rounded-lg border border-line bg-surface-2 p-4 text-sm leading-6 text-muted-foreground">
              <div className="flex flex-wrap items-center gap-2">
                <div className="font-medium text-foreground">
                  {isUpcoming ? workCopy.title : tr("mtgSummaryNoIntelligence")}
                </div>
                <Badge variant="outline" className={`rounded-md ${readinessBadgeClass(readiness.status)}`}>
                  {workCopy.title}
                </Badge>
              </div>
              <p className="mt-1">
                {isUpcoming ? workCopy.description : tr("mtgSummaryNoIntelligenceHint")}
              </p>
              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {readiness.checks.slice(0, 6).map((check) => (
                  <div
                    key={check.key}
                    className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-xs text-foreground"
                  >
                    <span className={`size-2 rounded-full ${checkDotClass(check.state)}`} />
                    <span className="min-w-0 truncate">{readinessCheckLabel(check, tr)}</span>
                    <span className="ms-auto text-2xs text-muted-foreground">{readinessCheckState(check, tr)}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {workStatus.primaryAction === "process" ? (
                  <Button size="sm" disabled={!canProcess} onClick={onProcessMeeting}>
                    <PlayCircleIcon data-icon="inline-start" className="size-4" />
                    {hasMeetImportableArtifact ? tr("mtgSummaryProcessFromGoogle") : tr("mtgSummaryProcessNow")}
                  </Button>
                ) : null}
                {workStatus.primaryAction === "sync_artifacts" ? (
                  <Button size="sm" onClick={onSyncMeetArtifacts}>
                    <RadioTowerIcon data-icon="inline-start" className="size-4" />
                    {tr("mtgSummarySyncMeet")}
                  </Button>
                ) : null}
                <Button size="sm" variant={workStatus.primaryAction === "upload" ? "default" : "outline"} onClick={onOpenUpload}>
                  <UploadIcon data-icon="inline-start" className="size-4" />
                  {tr("mtgSummaryUploadRecording")}
                </Button>
                <Button size="sm" variant="outline" onClick={onFindDriveRecordings}>
                  <FileAudioIcon data-icon="inline-start" className="size-4" />
                  {t.findDriveRecordings}
                </Button>
                {workStatus.primaryAction !== "sync_artifacts" ? (
                  <Button size="sm" variant="ghost" onClick={onSyncMeetArtifacts}>
                    <RadioTowerIcon data-icon="inline-start" className="size-4" />
                    {tr("mtgSummarySyncMeet")}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <>
              <AiProvenance
                state={provenance}
                dir={dir}
                sources={sourceColors}
                label={
                  provenance === "auto"
                    ? t.intelAutoLabel
                    : generatedAt
                      ? formatMessage(t.intelAiLabelAt, { time: generatedAt })
                      : t.intelAiLabel
                }
              >
                <p lang={summaryLanguage ?? undefined} className="leading-7">{text(overview, summaryLanguage)}</p>
              </AiProvenance>
              {moments.length ? (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-fg-3">
                  <span>{plural("mtgFromMoments", moments.length)}</span>
                  {moments.slice(0, 6).map((moment) => (
                    <PlayerCitation
                      key={moment.segmentId}
                      segmentId={moment.segmentId}
                      startMs={moment.startMs}
                      source="citation"
                      dictionary={t}
                    />
                  ))}
                </div>
              ) : null}
              {intelligence?.topics?.length ? (
                <div className="mt-3 flex flex-wrap items-center gap-1.5" aria-label={t.intelTopics}>
                  {intelligence.topics.map((topic) => (
                    <span key={topic} dir={dir} className="rounded-sm bg-surface-3 px-2 py-0.5 text-xs text-fg-2">
                      {text(topic, summaryLanguage)}
                    </span>
                  ))}
                </div>
              ) : null}
              {languageMismatch ? (
                <p role="status" className="mt-3 flex items-center gap-1.5 text-xs text-warn-text">
                  <AlertTriangleIcon aria-hidden className="size-3.5" />
                  {t.intelLanguageMismatch}
                </p>
              ) : null}
            </>
          )}
        </section>

        {/* Action items */}
        <section className="mt-8">
          <SectionHeader title={t.intelActions} />
          {actionItems.length ? (
            <ul className="grid gap-0.5">
              {actionItems.map((item) => {
                const due = dueLabel(item)
                const owner = item.owner ?? item.ownerText

                return (
                  <SummaryLine
                    key={item.id}
                    id={item.id}
                    text={item.title}
                    refs={actionItemRefs(item)}
                    dir={dir}
                    meetingId={meeting.id}
                    dictionary={t}
                    directory={directory}
                    targetType="action_item"
                    edited={item.editedByUser === true || item.origin === "user"}
                    leading={
                      <Checkbox
                        checked={item.status === "done"}
                        onCheckedChange={() => onToggleActionItem(item)}
                        className="mt-1.5"
                        aria-label={item.title}
                      />
                    }
                    meta={
                      <>
                        <span className="text-xs text-fg-2">
                          {owner ? <bdi>{owner}</bdi> : t.unassigned}
                        </span>
                        {due ? (
                          <span className="text-xs text-fg-3 [direction:ltr] [unicode-bidi:isolate]">
                            {formatMessage(t.intelDue, { date: due })}
                          </span>
                        ) : null}
                        {item.priority && item.priority !== "normal" ? (
                          <span className={`rounded-full px-2 text-xs ${priorityClass(item.priority)}`}>
                            {t[PRIORITY_KEYS[item.priority]] ?? item.priority}
                          </span>
                        ) : null}
                      </>
                    }
                  />
                )
              })}
            </ul>
          ) : (
            <p className="text-sm text-fg-3">{t.intelNoItems}</p>
          )}
        </section>

        {/* Decisions */}
        <section className="mt-8">
          <SectionHeader
            title={t.intelDecisions}
            action={
              decisions.length ? (
                <CopyButton label={t.intelCopy} text={decisions.map((item) => item.text).join("\n")} onCopy={onCopyText} />
              ) : undefined
            }
          />
          {itemList(decisions)}
        </section>

        {/* Open questions */}
        <section className="mt-8">
          <SectionHeader title={t.intelOpenQuestions} />
          {itemList(questions)}
        </section>

        {/* Template sections */}
        {sections.map((section) => {
          const sectionItems = section.itemIds.flatMap((id) => items.filter((item) => item.id === id))

          return (
            <section key={section.key} className="mt-8">
              <SectionHeader title={section.title ? text(section.title, summaryLanguage) : section.key} />
              {section.text ? (
                <p dir={dir} lang={summaryLanguage ?? undefined} className="mb-2 text-md leading-7 text-fg">
                  {text(section.text, summaryLanguage)}
                </p>
              ) : null}
              {sectionItems.length ? itemList(sectionItems) : section.text ? null : (
                <p className="text-sm text-fg-3">{t.intelSectionNoText}</p>
              )}
            </section>
          )
        })}

        {risks.length ? (
          <section className="mt-8">
            <SectionHeader title={t.intelRisks} />
            {itemList(risks)}
          </section>
        ) : null}
        {nextSteps.length ? (
          <section className="mt-8">
            <SectionHeader title={t.intelNextSteps} />
            {itemList(nextSteps)}
          </section>
        ) : null}
        {commitments.length ? (
          <section className="mt-8">
            <SectionHeader title={t.intelCommitments} />
            {itemList(commitments)}
          </section>
        ) : null}

        {/* Chapters */}
        {chapters.length ? (
          <section className="mt-8">
            <SectionHeader title={t.intelChapters} />
            <ChapterList chapters={chapters} dir={dir} dictionary={t} />
          </section>
        ) : null}

        {talkTime ? <div className="mt-8">{talkTime}</div> : null}

        {quotes.length ? (
          <section className="mt-8">
            <SectionHeader
              title={t.keyQuotesTitle}
              action={
                <CopyButton
                  label={t.intelCopy}
                  text={quotes.map((quote) => `${formatTimestamp(quote.startMs)} ${quote.speaker}: ${quote.text}`).join("\n")}
                  onCopy={onCopyText}
                />
              }
            />
            <div className="grid gap-2">
              {quotes.map((quote) => (
                <div
                  key={`${quote.segmentId}-${quote.startMs}`}
                  className="flex items-baseline gap-3 rounded-md border border-line bg-surface px-3 py-2 text-sm"
                >
                  <span className="w-16 shrink-0">
                    <PlayerCitation segmentId={quote.segmentId} startMs={quote.startMs} source="quote" dictionary={t} />
                  </span>
                  <span dir={meetingDir} className="min-w-0 text-muted-foreground">
                    <bdi>{quote.speaker}</bdi>: “{quote.text}”
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {generation ? (
          <footer className="mt-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-3 text-xs text-fg-3">
            <span className="font-mono [direction:ltr] [unicode-bidi:isolate]">
              {formatMessage(t.intelGeneratedBy, { provider: generation.provider, model: generation.model ?? "—" })}
            </span>
            {generation.language ? <span>{languageName(generation.language)}</span> : null}
            {generation.templateKey ? <span>{`${t.intelTemplate}: ${generation.templateKey}`}</span> : null}
            <span className="font-mono [direction:ltr] [unicode-bidi:isolate]">
              {typeof generation.costUsd === "number" ? `$${generation.costUsd.toFixed(4)}` : t.intelCostUnknown}
            </span>
            {generation.fallbackUsed || generation.provider === "heuristic" ? (
              <span className="text-warn-text">{t.intelFallback}</span>
            ) : null}
          </footer>
        ) : null}
      </div>
    </div>
  )
}
