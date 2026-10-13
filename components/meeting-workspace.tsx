"use client"

/**
 * Reading column for one meeting (M4): header, the sticky player (the
 * view's one primary action is Play), then Summary · Transcript · Ask and the
 * secondary tabs. The player provider wraps everything so citations, action
 * items, quotes and the transcript all seek the same clock.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from "react"
import dynamic from "next/dynamic"
import {
  CalendarSyncIcon,
  FileAudioIcon,
  ListTodoIcon,
  MessageSquareIcon,
  SettingsIcon,
  UploadIcon,
} from "lucide-react"

import { AskMeetingPanel } from "@/components/ask-meeting-panel"
import { useJson } from "@/components/intelligence/use-json"
import { MeetingHeader } from "@/components/meeting-header"
import { MeetingSummaryView } from "@/components/meeting-summary-view"
import { LazyMeetingPlayer } from "@/components/player/lazy"
import { TranscriptSkeleton } from "@/components/transcript/transcript-skeleton"
import {
  MeetingPlayerProvider,
  useMeetingPlayer,
} from "@/components/player/meeting-player-provider"
import { useSpeakerDirectory } from "@/components/player/speaker-directory"
import { directionForLanguage } from "@/components/speaker-display"
import { TalkTimePanel } from "@/components/talk-time-panel"
import type { MeetingTranscriptHandle } from "@/components/transcript/use-meeting-transcript"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useShellUrl } from "@/hooks/use-shell-url"
import { MEETING_TABS, type MeetingTab } from "@/lib/client/shell-url"
import type { Dictionary } from "@/lib/i18n/dictionaries"
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
import { getMeetingDurationMs } from "@/lib/meetings/duration"
import { normalizeIntelligence } from "@/lib/intelligence/normalize"
import type { TaskMember } from "@/lib/tasks/types"

// Only rendered on the transcript tab / when confirming; loaded on demand.
const SpeakerMappingPanel = dynamic(
  () => import("@/components/speaker-mapping-panel").then((mod) => mod.SpeakerMappingPanel),
  { ssr: false, loading: () => <Skeleton className="h-14 w-full rounded-lg" /> }
)
/**
 * M5 transcript (Package C's `TranscriptTimeline`: chapter headings,
 * comment anchors, clip ranges, reactions over M4's TranscriptView), code
 * split like M4's LazyTranscriptView.
 */
const LazyTranscriptTimeline = dynamic(
  () => import("@/components/transcript-timeline").then((mod) => mod.TranscriptTimeline),
  { ssr: false, loading: () => <TranscriptSkeleton /> }
)
/**
 * M5 panels (clips, comments, prep, follow-up, tasks) render only on their
 * tab or when the drawer opens: code split to keep the meeting route small.
 */
const ClipList = dynamic(() => import("@/components/clips/clip-list").then((mod) => mod.ClipList), {
  ssr: false,
  loading: () => <Skeleton className="h-24 w-full rounded-lg" />,
})
const CommentsDrawer = dynamic(
  () => import("@/components/comments/comments-drawer").then((mod) => mod.CommentsDrawer),
  { ssr: false }
)
const PrepPanel = dynamic(() => import("@/components/intelligence/prep-panel").then((mod) => mod.PrepPanel), {
  ssr: false,
  loading: () => <Skeleton className="h-32 w-full rounded-lg" />,
})
const FollowUpPanel = dynamic(
  () => import("@/components/intelligence/follow-up-panel").then((mod) => mod.FollowUpPanel),
  { ssr: false, loading: () => <Skeleton className="h-32 w-full rounded-lg" /> }
)
const ActionItemEditor = dynamic(
  () => import("@/components/tasks/action-item-editor").then((mod) => mod.ActionItemEditor),
  { ssr: false, loading: () => <Skeleton className="h-24 w-full rounded-lg" /> }
)
const ReprocessConfirmDialog = dynamic(
  () => import("@/components/meeting-dialogs").then((mod) => mod.ReprocessConfirmDialog),
  { ssr: false }
)

/** Scroll distance that compacts the player, and the one that restores it. */
const COMPACT_AT_PX = 24
const EXPAND_BELOW_PX = 4

type ReprocessMode = "full" | "summary" | "tasks" | "transcript-cleanup"
/** `summary | transcript | ask` live in the shell URL (`?tab=`); the rest are local. */
type LocalTab = "tasks" | "clips" | "prep" | "followup"
type TabValue = MeetingTab | LocalTab

const isUrlTab = (value: string): value is MeetingTab => (MEETING_TABS as readonly string[]).includes(value)

type MembersResponse = { members: Array<{ userId: string; email: string; name: string | null }> }

/** Tasks tab: Package B's editor with workspace members as owner options. */
function TasksTab({
  meeting,
  locale,
  canEdit,
}: {
  meeting: MeetingRecord
  locale: SupportedLocale
  canEdit: boolean
}) {
  const { data } = useJson<MembersResponse>("/api/workspaces/current/members")
  const members = useMemo<TaskMember[]>(
    () =>
      (data?.members ?? []).map((member) => ({
        userId: member.userId,
        email: member.email,
        name: member.name ?? undefined,
      })),
    [data?.members]
  )

  return (
    <ActionItemEditor
      meetingId={meeting.id}
      items={meeting.summary?.actionItems ?? []}
      participants={meeting.participantDetails ?? []}
      speakers={meeting.speakers ?? []}
      members={members}
      meetingStartedAt={meeting.startedAt}
      locale={locale}
      canEdit={canEdit}
    />
  )
}

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
  transcript,
  permissions = { canWrite: false, canManage: false },
  initialMs,
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
  /** Transcript of the selected meeting (`useMeetingTranscript`). */
  transcript?: MeetingTranscriptHandle
  permissions?: MeetingPermissions
  /** `?t=` for this meeting, in ms. */
  initialMs?: number
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
  // M9 D1: the URL owns summary/transcript/ask (`replace`, no history entry);
  // tabs outside the shell contract stay local until a URL tab is chosen.
  const shell = useShellUrl(locale)
  const { navigate } = shell
  const [localTab, setLocalTab] = useState<LocalTab | null>(null)
  const tab: TabValue = localTab ?? shell.state.tab
  const meetingId = meeting?.id
  const setTab = useCallback(
    (value: TabValue) => {
      if (!isUrlTab(value)) {
        setLocalTab(value)
        return
      }
      setLocalTab(null)
      if (meetingId) navigate({ meeting: meetingId, tab: value }, { replace: true })
    },
    [meetingId, navigate]
  )
  // M6: the Ask panel loads on first open and then stays mounted, so a
  // conversation survives tab switches (citations seek from the Ask tab).
  const [askOpened, setAskOpened] = useState(false)
  // Compact player: a tab pane scrolled, or (short viewports) the whole column.
  const [paneCompact, setPaneCompact] = useState(false)
  const [columnCompact, setColumnCompact] = useState(false)
  const compact = paneCompact || columnCompact
  const [confirmReprocess, setConfirmReprocess] = useState(false)
  const [confirmRequested, setConfirmRequested] = useState(false)
  const [commentsOpen, setCommentsOpen] = useState(false)
  const rawIntelligence = meeting?.intelligence
  const chapters = useMemo(
    () => (rawIntelligence ? (normalizeIntelligence(rawIntelligence).chapters ?? []) : []),
    [rawIntelligence]
  )
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
  const openTranscript = useCallback(() => setTab("transcript"), [setTab])
  const summaryRun = meeting?.aiRuns?.find((run) => run.task === "summary.generate")
  const editedAfterSummary = Boolean(
    meeting?.transcriptEditedAt &&
      summaryRun?.completedAt &&
      meeting.transcriptEditedAt > summaryRun.completedAt
  )
  const editedCount = meeting?.editedSegmentCount ?? 0

  const reprocess = (mode: ReprocessMode) => {
    if (mode === "full" && editedCount > 0) {
      setConfirmRequested(true)
      setConfirmReprocess(true)
      return
    }
    onReprocessMeeting(mode)
  }

  const trackCompact = (event: UIEvent<HTMLElement>) => {
    const next = event.currentTarget.scrollTop > COMPACT_AT_PX

    if (next !== paneCompact) setPaneCompact(next)
  }

  // Hysteresis: compacting shrinks the column, which can clamp its scrollTop;
  // only expanding near the very top keeps that from oscillating.
  const trackColumnCompact = (event: UIEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return

    const top = event.currentTarget.scrollTop

    if (!columnCompact && top > COMPACT_AT_PX) setColumnCompact(true)
    else if (columnCompact && top < EXPAND_BELOW_PX) setColumnCompact(false)
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
            {dictionary.mtgEmptySyncGoogle}
          </Button>
          <Button variant="outline" onClick={onOpenUpload}>
            <UploadIcon data-icon="inline-start" />
            {dictionary.mtgEmptyUpload}
          </Button>
          <Button variant="ghost" onClick={onCheckSetup}>
            <SettingsIcon data-icon="inline-start" />
            {dictionary.mtgEmptyCheckSetup}
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
      durationMs={getMeetingDurationMs(meeting)}
      initialMs={initialMs}
      markers={markers}
      dictionary={dictionary}
      speakerName={speakerName}
    >
      <TabCommandBridge tab={tab} onOpenTranscript={openTranscript} />
      {/*
        On large screens the column scrolls as a whole when the viewport is too
        short for header + player + a usable tab panel; the player stays sticky.
      */}
      <div
        className="ms-scrollbar flex min-h-0 min-w-0 flex-col bg-surface lg:h-full lg:overflow-y-auto"
        onScroll={trackColumnCompact}
      >
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

        <div className="flex justify-end px-4 md:px-6">
          <Button size="sm" variant="ghost" onClick={() => setCommentsOpen(true)}>
            <MessageSquareIcon data-icon="inline-start" className="size-4" />
            {dictionary.intelComments}
          </Button>
        </div>
        <CommentsDrawer meetingId={meeting.id} open={commentsOpen} onOpenChange={setCommentsOpen} />

        <div className="sticky top-0 z-(--z-sticky) shrink-0 bg-surface px-4 pt-3 md:px-6">
          <LazyMeetingPlayer
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
            if (value === "ask") setAskOpened(true)
            setPaneCompact(false)
          }}
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-0 lg:min-h-120"
        >
          <TabsList
            variant="line"
            className="mx-auto mt-3 grid min-h-9 w-full max-w-172 shrink-0 grid-cols-4 border-b border-line bg-transparent p-0 px-5 md:grid-cols-7"
          >
            <TabsTrigger value="summary">{dictionary.summary}</TabsTrigger>
            <TabsTrigger value="transcript">{dictionary.transcript}</TabsTrigger>
            <TabsTrigger value="ask">{dictionary.ask}</TabsTrigger>
            <TabsTrigger value="tasks">
              {dictionary.intelTasks}
              <span className="ms-1 rounded-full bg-surface-2 px-2 text-xs text-muted-foreground">
                {meeting.summary?.actionItems.length ?? 0}
              </span>
            </TabsTrigger>
            <TabsTrigger value="clips">{dictionary.intelClips}</TabsTrigger>
            <TabsTrigger value="prep">{dictionary.intelPrep}</TabsTrigger>
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
              directory={directory}
              locale={locale}
              canWrite={permissions.canWrite}
            />
          </TabsContent>

          <TabsContent
            value="transcript"
            className="ms-scrollbar mt-0 flex min-h-0 flex-col overflow-y-auto px-5 pt-4 pb-2 md:px-8"
          >
            <LazyTranscriptTimeline
              chapters={chapters}
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

          <TabsContent value="ask" keepMounted className={scrollPane} onScroll={trackCompact}>
            <div className="mx-auto max-w-3xl">
              {/* M6: streamed, cited answers; code split, mounted only on this tab. */}
              {askOpened || tab === "ask" ? (
                <AskMeetingPanel dictionary={dictionary} locale={locale} meetingId={meeting.id} />
              ) : null}
            </div>
          </TabsContent>

          <TabsContent value="tasks" className={scrollPane} onScroll={trackCompact}>
            <section className="ms-card mx-auto max-w-5xl p-4">
              <div className="mb-3 flex items-center gap-2">
                <ListTodoIcon aria-hidden="true" className="size-4 text-primary" />
                <h3 className="text-sm font-semibold">{dictionary.actionItems}</h3>
              </div>
              <TasksTab meeting={meeting} locale={locale} canEdit={permissions.canWrite} />
            </section>
          </TabsContent>

          <TabsContent value="clips" className={scrollPane} onScroll={trackCompact}>
            <section className="mx-auto max-w-5xl">
              <ClipList meetingId={meeting.id} />
            </section>
          </TabsContent>

          <TabsContent value="prep" className={scrollPane}>
            <PrepPanel meetingId={meeting.id} dictionary={dictionary} locale={locale} canWrite={permissions.canWrite} />
          </TabsContent>

          <TabsContent value="followup" className={scrollPane}>
            <FollowUpPanel
              meetingId={meeting.id}
              dictionary={dictionary}
              draft={meeting.intelligence?.followUpDraft}
              defaultLanguage={directionForLanguage(meeting.language) === "ltr" ? "en" : "he"}
              onCopyText={onCopyText}
              canWrite={permissions.canWrite}
            />
          </TabsContent>
        </Tabs>
      </div>

      {confirmReprocess || confirmRequested ? (
        <ReprocessConfirmDialog
          dictionary={dictionary}
          open={confirmReprocess}
          onOpenChange={setConfirmReprocess}
          editedCount={editedCount}
          onConfirm={() => {
            setConfirmReprocess(false)
            onReprocessMeeting("full")
          }}
        />
      ) : null}
    </MeetingPlayerProvider>
  )
}
