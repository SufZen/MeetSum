"use client"

/**
 * Collaborative transcript (M5 C5) on top of M4's virtualized, player-synced
 * `TranscriptView`:
 * - chapter headings from `intelligence.chapters` (only chapters that
 *   resolve to a real segment; the heading's chip seeks to it),
 * - per-row hover actions: comment, react, select for a clip
 *   (shift-click selects a range), plus always-visible comment/reaction
 *   badges,
 * - a selection bar that opens the "Create clip" dialog.
 *
 * `TranscriptView` stays exported for M3/M4 callers.
 */
import { useCallback, useMemo, useState, type ComponentProps, type MouseEvent } from "react"
import { ScissorsIcon, XIcon } from "lucide-react"

import { ClipCreateDialog } from "@/components/clips/clip-create-dialog"
import {
  commentCount,
  formatMessage,
  reactionsFor,
  threadsFor,
  useCollabStrings,
  useMeetingComments,
} from "@/components/comments/collab-client"
import { CommentAnchor } from "@/components/comments/comment-anchor"
import { ReactionBar } from "@/components/comments/reaction-bar"
import { directionForLanguage } from "@/components/speaker-display"
import { TranscriptView } from "@/components/transcript/transcript-view"
import { Button } from "@/components/ui/button"
import { CitationChip } from "@/components/ui/meeting-atoms"
import { chapterHeadings, nextSelection, selectionRange } from "@/lib/clips/selection"
import type { Chapter } from "@/lib/intelligence/types"
import type { TranscriptSegmentWire } from "@/lib/meetings/transcript-wire"
import { usePlayer } from "@/lib/player/contract"
import { cn } from "@/lib/utils"

export { TranscriptView }

type TranscriptViewProps = ComponentProps<typeof TranscriptView>

export type TranscriptTimelineProps = TranscriptViewProps & {
  /** `intelligence.chapters` (normalized); headings only for real segments. */
  chapters?: readonly Chapter[]
  /** Comments, reactions and clips (off on share pages / without a meeting id). */
  collaboration?: boolean
  /** Clips can be created (meeting:write). */
  canCreateClips?: boolean
}

export function TranscriptTimeline({
  chapters,
  collaboration,
  canCreateClips,
  ...props
}: TranscriptTimelineProps) {
  const meetingId = props.meetingId
  const enabled = Boolean((collaboration ?? true) && meetingId && !props.shareToken)

  if (!enabled || !meetingId) {
    return <ChapterOnlyTranscript chapters={chapters} {...props} />
  }

  return (
    <CollaborativeTranscript
      meetingId={meetingId}
      chapters={chapters}
      canCreateClips={canCreateClips ?? props.canWrite ?? false}
      {...props}
    />
  )
}

function ChapterHeading({
  chapter,
  dir,
  meetingId,
  label,
}: {
  chapter: Chapter
  dir?: "rtl" | "ltr"
  meetingId?: string
  label: string
}) {
  const player = usePlayer()

  return (
    <div className="flex items-center gap-2 px-2 pt-4 pb-1">
      <span className="text-2xs font-semibold text-fg-3">{label}</span>
      <h3 dir={dir} className="min-w-0 truncate text-sm font-semibold text-fg">
        {chapter.title}
      </h3>
      <CitationChip
        seconds={chapter.startMs / 1000}
        onClick={() => player.seek(chapter.startMs, { play: true, segmentId: chapter.startSegmentId })}
      />
      {meetingId ? (
        <span className="ms-auto">
          <CommentAnchor meetingId={meetingId} targetType="chapter" targetId={chapter.id} />
        </span>
      ) : null}
    </div>
  )
}

function useHeadings(chapters: readonly Chapter[] | undefined, segments: readonly TranscriptSegmentWire[]) {
  return useMemo(() => chapterHeadings(chapters, segments), [chapters, segments])
}

function ChapterOnlyTranscript({
  chapters,
  ...props
}: TranscriptViewProps & { chapters?: readonly Chapter[] }) {
  const { t } = useCollabStrings(props.locale)
  const headings = useHeadings(chapters, props.segments)
  const dir = directionForLanguage(props.meetingLanguage)

  return (
    <TranscriptView
      {...props}
      renderBeforeSegment={
        headings.size
          ? (segment) => {
              const chapter = headings.get(segment.id)

              return chapter ? <ChapterHeading chapter={chapter} dir={dir} label={t.clipsChapter} /> : null
            }
          : undefined
      }
    />
  )
}

function CollaborativeTranscript({
  meetingId,
  chapters,
  canCreateClips,
  header,
  ...props
}: TranscriptViewProps & { meetingId: string; chapters?: readonly Chapter[]; canCreateClips: boolean }) {
  const { t } = useCollabStrings(props.locale)
  const comments = useMeetingComments(meetingId)
  const headings = useHeadings(chapters, props.segments)
  const dir = directionForLanguage(props.meetingLanguage)
  const [selection, setSelection] = useState<{ ids: Set<string>; anchor?: number }>(() => ({
    ids: new Set(),
  }))
  const [dialogOpen, setDialogOpen] = useState(false)
  const canComment = !(comments.status === "error" && comments.error?.code === "user_required")
  const range = useMemo(() => selectionRange(selection.ids, props.segments), [selection.ids, props.segments])
  const clipSelection = useMemo(() => (range ? { segmentIds: range.segmentIds } : undefined), [range])
  const previewRange = useMemo(
    () => (range ? { startMs: range.startMs, endMs: range.endMs } : undefined),
    [range]
  )

  const onSelect = useCallback(
    (index: number, event: MouseEvent) => {
      setSelection((current) => nextSelection(current, props.segments, index, event.shiftKey))
    },
    [props.segments]
  )

  const clearSelection = () => setSelection({ ids: new Set() })

  const selectionBar =
    canCreateClips && range ? (
      <div
        role="region"
        aria-label={t.clipsCreate}
        className="flex flex-wrap items-center gap-2 rounded-lg border border-brand bg-brand-soft-2 px-3 py-2 text-sm"
      >
        <span>{formatMessage(t.clipsSelectionCount, { count: range.segmentIds.length })}</span>
        <Button size="sm" variant="secondary" onClick={() => setDialogOpen(true)}>
          <ScissorsIcon />
          {t.clipsCreate}
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label={t.clipsClearSelection} onClick={clearSelection}>
          <XIcon />
        </Button>
      </div>
    ) : null

  return (
    <>
      <TranscriptView
        {...props}
        meetingId={meetingId}
        header={
          header || selectionBar ? (
            <>
              {header}
              {selectionBar}
            </>
          ) : undefined
        }
        selectedSegmentIds={selection.ids}
        renderBeforeSegment={(segment) => {
          const chapter = headings.get(segment.id)

          return chapter ? (
            <ChapterHeading chapter={chapter} dir={dir} meetingId={meetingId} label={t.clipsChapter} />
          ) : null
        }}
        renderSegmentBadges={(segment) => {
          if (!canComment) return null

          const count = commentCount(threadsFor(comments.snapshot, "segment", segment.id))
          const reactions = reactionsFor(comments.snapshot, "segment", segment.id).filter(
            (reaction) => reaction.count > 0
          )

          if (!count && !reactions.length) return null

          return (
            <span className="inline-flex items-center gap-1">
              {count ? (
                <CommentAnchor meetingId={meetingId} targetType="segment" targetId={segment.id} count={count} />
              ) : null}
              {reactions.length ? (
                <ReactionBar
                  meetingId={meetingId}
                  targetType="segment"
                  targetId={segment.id}
                  reactions={reactions}
                />
              ) : null}
            </span>
          )
        }}
        renderSegmentActions={(segment, index) => {
          const count = commentCount(threadsFor(comments.snapshot, "segment", segment.id))
          const hasReactions = reactionsFor(comments.snapshot, "segment", segment.id).some(
            (reaction) => reaction.count > 0
          )
          const selected = selection.ids.has(segment.id)

          return (
            <>
              {canComment && !count ? (
                <CommentAnchor meetingId={meetingId} targetType="segment" targetId={segment.id} />
              ) : null}
              {canComment && !hasReactions ? (
                <ReactionBar meetingId={meetingId} targetType="segment" targetId={segment.id} reactions={[]} />
              ) : null}
              {canCreateClips ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-pressed={selected}
                  aria-label={t.clipsSelectSegment}
                  title={t.clipsSelectSegment}
                  className={cn(selected && "bg-brand-soft-2 text-brand-text")}
                  onClick={(event) => onSelect(index, event)}
                >
                  <ScissorsIcon />
                </Button>
              ) : null}
            </>
          )
        }}
      />
      {canCreateClips ? (
        <ClipCreateDialog
          meetingId={meetingId}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          selection={clipSelection}
          previewRange={previewRange}
          onCreated={clearSelection}
        />
      ) : null}
    </>
  )
}
