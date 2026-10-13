"use client"

/**
 * Reading column for one meeting (M4): header, the sticky player (the
 * view's one primary action is Play), then Summary · Transcript · Ask and the
 * secondary tabs. The player provider wraps everything so citations, action
 * items, quotes and the transcript all seek the same clock.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from "react"
import {
  CalendarSyncIcon,
  FileAudioIcon,
  ListTodoIcon,
  SettingsIcon,
  UploadIcon,
} from "lucide-react"

import { ActionItemList } from "@/components/action-item-list"
import { AskMeetingPanel, type AskCitation } from "@/components/ask-meeting-panel"
import { MeetingHeader } from "@/components/meeting-header"
import { MeetingSummaryView } from "@/components/meeting-summary-view"
import { MeetingPlayer } from "@/components/player/meeting-player"
import {
  MeetingPlayerProvider,
  useMeetingPlayer,
} from "@/components/player/meeting-player-provider"
import { useSpeakerDirectory } from "@/components/player/speaker-directory"
import { directionForLanguage } from "@/components/speaker-display"
import { SpeakerMappingPanel } from "@/components/speaker-mapping-panel"
import { TalkTimePanel } from "@/components/talk-time-panel"
import { TranscriptView } from "@/components/transcript/transcript-view"
import type { MeetingTranscriptHandle } from "@/components/transcript/use-meeting-transcript"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatMessage, type Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"
import { describeMeetingMedia } from "@/lib/media/playback-select"
import type {
  ActionItem,
  JobRecord,
  MeetingRecord,
  MeetingVisibility,
} from "@/lib/meetings/repository"
import { buildActionItemMarkers } from "@/lib/player/citations"
import { buildTranscriptIndex } from "@/lib/player/word-index"
import { meetingDurationMs } from "@/lib/player/time-format"

type ReprocessMode = "full" | "summary" | "tasks" | "transcript-cleanup"
type TabValue = "summary" | "transcript" | "ask" | "tasks" | "prep" | "followup"

export type MeetingPermissions = { canWrite: boolean; canManage: boolean }

/**
 * Switches tabs on player commands (`/` search, "Open in transcript"). The
 * search box only exists on the transcript tab, so `/` from another tab
 * re-emits once the transcript has mounted.
 */
function TabCommandBridge({ tab, onOpenTranscript }: { tab: TabValue; onOpenTranscript: () => void }) {
  const { emitCommand, subscribeCommand } = useMeetingPlayer()
  const tabRef = useRef(tab)

  useEffect(() => {
    tabRef.current = tab
  }, [tab])

  useEffect(
    () =>
      subscribeCommand((command) => {
        if (command !== "openTranscript" && command !== "focusSearch") return
        if (tabRef.current === "transcript") return

        onOpenTranscript()
        if (command === "focusSearch") {
          window.setTimeout(() => emitCommand("focusSearch"), 50)
        }
      }),
    [emitCommand, onOpenTranscript, subscribeCommand]
  )

  return null
}

export function MeetingWorkspace({
  dictionary,
  meeting,
  jobs,
  question,
  answer,
  askCitations,
  asking,
  transcript,
  permissions = { canWrite: false, canManage: false },
  initialMs,
  onQuestionChange,
  onAsk,
  onToggleActionItem,
  onReprocessMeeting,
  onProcessMeeting,
  onRetryJob,
  onOpenUpload,
  onFindDriveRecordings,
  onSyncMeetArtifacts,
  onSyncGoogle,
  onCheckSetup,
  onShareMeeting,
  onVisibilityChanged,
  onToggleFavorite,
  onShowParticipants,
  onSpeakersChanged,
  onAddToRoom,
  onCopyText,
  onRename,
  onDelete,
  locale,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
  meeting: MeetingRecord | null
  jobs: JobRecord[]
  question: string
  answer?: string
  askCitations?: readonly AskCitation[]
  asking?: boolean
  /** Transcript of the selected meeting (`useMeetingTranscript`). */
  transcript?: MeetingTranscriptHandle
  permissions?: MeetingPermissions
  /** `?t=` for this meeting, in ms. */
  initialMs?: number
  onQuestionChange: (value: string) => void
  onAsk: () => void
  onToggleActionItem: (item: ActionItem) => void
  onReprocessMeeting: (mode: ReprocessMode) => void
  onProcessMeeting: () => void
  onRetryJob: (job: JobRecord) => void
  onOpenUpload: () => void
  onFindDriveRecordings: () => void
  onSyncMeetArtifacts: () => void
  onSyncGoogle: () => void
  onCheckSetup: () => void
  onShareMeeting: () => void
  onVisibilityChanged?: (visibility: MeetingVisibility) => void
  onToggleFavorite: () => void
  onShowParticipants: () => void
  /** A speaker was confirmed, rejected, renamed or merged (or a line reassigned). */
  onSpeakersChanged: () => void
  onAddToRoom: () => void
  onCopyText: (text: string, label: string) => void
  onRename?: (title: string) => Promise<boolean>
  onDelete?: () => Promise<boolean>
}) {
  const [tab, setTab] = useState<TabValue>("summary")
  const [compact, setCompact] = useState(false)
  const [confirmReprocess, setConfirmReprocess] = useState(false)
  const segments = useMemo(() => transcript?.data?.segments ?? [], [transcript?.data?.segments])
  const speakers = useMemo(
    () => transcript?.data?.speakers ?? meeting?.speakers ?? [],
    [meeting?.speakers, transcript?.data?.speakers]
  )
  const participants = useMemo(() => meeting?.participantDetails ?? [], [meeting?.participantDetails])
  const directory = useSpeakerDirectory(speakers, participants, dictionary.speakersGenericLabel)
  const media = useMemo(() => describeMeetingMedia(meeting?.mediaAssets ?? []), [meeting?.mediaAssets])
  const markers = useMemo(
    () => buildActionItemMarkers(meeting?.summary?.actionItems ?? [], segments, buildTranscriptIndex(segments)),
    [meeting?.summary?.actionItems, segments]
  )
  const speakerName = useCallback(
    (segment: { speaker: string; speakerId?: string }) => directory.forSegment(segment).name,
    [directory]
  )
  const openTranscript = useCallback(() => setTab("transcript"), [])
  const summaryRun = meeting?.aiRuns?.find((run) => run.task === "summary.generate")
  const editedAfterSummary = Boolean(
    meeting?.transcriptEditedAt &&
      summaryRun?.completedAt &&
      meeting.transcriptEditedAt > summaryRun.completedAt
  )
  const editedCount = meeting?.editedSegmentCount ?? 0

  const reprocess = (mode: ReprocessMode) => {
    if (mode === "full" && editedCount > 0) {
      setConfirmReprocess(true)
      return
    }
    onReprocessMeeting(mode)
  }

  const trackCompact = (event: UIEvent<HTMLElement>) => {
    const next = event.currentTarget.scrollTop > 24

    if (next !== compact) setCompact(next)
  }

  if (!meeting) {
    return (
      <div className="flex min-h-130 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-line bg-surface/70 p-8 text-center lg:h-full">
        <FileAudioIcon aria-hidden="true" className="size-10 text-muted-foreground" />
        <h2 className="text-xl font-semibold">{dictionary.noMeetingsTitle}</h2>
        <p className="max-w-sm text-sm leading-6 text-muted-foreground">
          {dictionary.noMeetingsDescription}
        </p>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <Button onClick={onSyncGoogle}>
            <CalendarSyncIcon data-icon="inline-start" />
            Sync Google Workspace
          </Button>
          <Button variant="outline" onClick={onOpenUpload}>
            <UploadIcon data-icon="inline-start" />
            Upload or import recording
          </Button>
          <Button variant="ghost" onClick={onCheckSetup}>
            <SettingsIcon data-icon="inline-start" />
            Check setup
          </Button>
        </div>
      </div>
    )
  }

  const talkTime = (
    <TalkTimePanel
      dictionary={dictionary}
      locale={locale}
      speakers={speakers}
      participants={participants}
      segments={segments}
    />
  )
  const scrollPane = "ms-scrollbar mt-0 min-h-0 overflow-y-auto px-5 py-6 md:px-8"

  return (
    <MeetingPlayerProvider
      key={meeting.id}
      meetingId={meeting.id}
      mediaBaseUrl={`/api/meetings/${encodeURIComponent(meeting.id)}`}
      media={media}
      segments={segments}
      durationMs={meetingDurationMs(meeting)}
      initialMs={initialMs}
      markers={markers}
      dictionary={dictionary}
      speakerName={speakerName}
    >
      <TabCommandBridge tab={tab} onOpenTranscript={openTranscript} />
      <div className="flex min-h-0 min-w-0 flex-col bg-surface lg:h-full">
        <MeetingHeader
          meeting={meeting}
          locale={locale}
          onShare={onShareMeeting}
          onToggleFavorite={onToggleFavorite}
          onShowParticipants={onShowParticipants}
          onAddToRoom={onAddToRoom}
          dictionary={dictionary}
          onVisibilityChanged={onVisibilityChanged}
          canWrite={permissions.canWrite}
          canManage={permissions.canManage}
          onRename={onRename}
          onDelete={onDelete}
        />

        <div className="sticky top-0 z-(--z-sticky) shrink-0 bg-surface px-4 pt-3 md:px-6">
          <MeetingPlayer
            dictionary={dictionary}
            locale={locale}
            directory={directory}
            compact={compact}
            className="mx-auto max-w-5xl"
          />
        </div>

        <Tabs
          value={tab}
          onValueChange={(value) => {
            setTab(value as TabValue)
            setCompact(false)
          }}
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-0"
        >
          <TabsList
            variant="line"
            className="mx-auto mt-3 grid min-h-9 w-full max-w-172 shrink-0 grid-cols-3 border-b border-line bg-transparent p-0 px-5 md:grid-cols-6"
          >
            <TabsTrigger value="summary">{dictionary.summary}</TabsTrigger>
            <TabsTrigger value="transcript">{dictionary.transcript}</TabsTrigger>
            <TabsTrigger value="ask">{dictionary.ask}</TabsTrigger>
            <TabsTrigger value="tasks">
              Tasks
              <span className="ms-1 rounded-full bg-surface-2 px-2 text-xs text-muted-foreground">
                {meeting.summary?.actionItems.length ?? 0}
              </span>
            </TabsTrigger>
            <TabsTrigger value="prep">Prep</TabsTrigger>
            <TabsTrigger value="followup">{dictionary.followUp}</TabsTrigger>
          </TabsList>

          <TabsContent value="summary" className="ms-scrollbar mt-0 min-h-0 overflow-y-auto" onScroll={trackCompact}>
            <MeetingSummaryView
              dictionary={dictionary}
              meeting={meeting}
              jobs={jobs}
              onToggleActionItem={onToggleActionItem}
              onReprocessMeeting={reprocess}
              onProcessMeeting={onProcessMeeting}
              onRetryJob={onRetryJob}
              onOpenUpload={onOpenUpload}
              onFindDriveRecordings={onFindDriveRecordings}
              onSyncMeetArtifacts={onSyncMeetArtifacts}
              onCopyText={onCopyText}
              talkTime={<div className="2xl:hidden">{talkTime}</div>}
            />
          </TabsContent>

          <TabsContent value="transcript" className="mt-0 flex min-h-0 flex-col px-5 pt-4 pb-2 md:px-8">
            <TranscriptView
              className="mx-auto h-full w-full max-w-5xl"
              fill
              dictionary={dictionary}
              locale={locale}
              meetingId={meeting.id}
              meetingLanguage={transcript?.data?.language ?? meeting.language}
              segments={segments}
              speakers={speakers}
              participants={participants}
              status={transcript?.status ?? "loading"}
              canWrite={permissions.canWrite}
              transcript={transcript}
              hasSummary={Boolean(meeting.summary?.overview)}
              editedAfterSummary={editedAfterSummary}
              onTranscriptChanged={onSpeakersChanged}
              header={
                <SpeakerMappingPanel
                  meetingId={meeting.id}
                  dictionary={dictionary}
                  meetingLanguage={meeting.language}
                  onChanged={() => {
                    transcript?.refetch()
                    onSpeakersChanged()
                  }}
                  onManageParticipants={onShowParticipants}
                />
              }
            />
          </TabsContent>

          <TabsContent value="ask" className={scrollPane} onScroll={trackCompact}>
            <div className="mx-auto max-w-3xl">
              <AskMeetingPanel
                dictionary={dictionary}
                question={question}
                answer={answer}
                citations={askCitations}
                answerDir={directionForLanguage(meeting.language)}
                asking={asking}
                disabled={!meeting}
                onQuestionChange={onQuestionChange}
                onAsk={onAsk}
              />
            </div>
          </TabsContent>

          <TabsContent value="tasks" className={scrollPane} onScroll={trackCompact}>
            <section className="ms-card mx-auto max-w-5xl p-4">
              <div className="mb-3 flex items-center gap-2">
                <ListTodoIcon aria-hidden="true" className="size-4 text-primary" />
                <h3 className="text-sm font-semibold">{dictionary.actionItems}</h3>
              </div>
              <ActionItemList
                items={meeting.summary?.actionItems}
                unassigned={dictionary.unassigned}
                onToggle={onToggleActionItem}
                dictionary={dictionary}
              />
            </section>
          </TabsContent>

          <TabsContent value="prep" className={scrollPane}>
            <section className="ms-card mx-auto max-w-3xl p-4 text-sm leading-6 text-muted-foreground">
              Gmail-aware prep, linked Drive docs, and previous context packets will
              land here after the Calendar/Drive spine is running.
            </section>
          </TabsContent>

          <TabsContent value="followup" className={scrollPane}>
            <section className="ms-card mx-auto max-w-3xl p-4 text-sm leading-6 text-muted-foreground">
              {meeting.intelligence?.followUpDraft ??
                "Follow-up draft will appear after structured intelligence runs."}
            </section>
          </TabsContent>
        </Tabs>
      </div>

      <AlertDialog open={confirmReprocess} onOpenChange={setConfirmReprocess}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{dictionary.transcriptReprocessTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {formatMessage(dictionary.transcriptReprocessDescription, { count: editedCount })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{dictionary.cancel}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmReprocess(false)
                onReprocessMeeting("full")
              }}
            >
              {dictionary.transcriptReprocessConfirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </MeetingPlayerProvider>
  )
}
