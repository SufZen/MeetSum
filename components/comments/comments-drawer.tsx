"use client"

/**
 * All comment threads of a meeting (M5 C5), filterable by open / resolved.
 * Each thread names its target and quotes it; an orphaned thread (target
 * gone after regeneration) says so. A citation chip is shown only for a
 * live transcript-segment target — it resolves to a real segment.
 */
import { useMemo, useState } from "react"

import {
  useCollabStrings,
  useMeetingComments,
  type CollabStrings,
} from "@/components/comments/collab-client"
import { CommentThreadView } from "@/components/comments/comment-thread"
import { CitationChip } from "@/components/ui/meeting-atoms"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { usePlayer } from "@/lib/player/contract"
import type { CommentTargetType, CommentThread } from "@/lib/comments/types"

export type CommentsDrawerProps = {
  meetingId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

type Filter = "open" | "resolved" | "all"

function targetLabel(t: CollabStrings, type: CommentTargetType): string {
  switch (type) {
    case "segment":
      return t.commentsTargetSegment
    case "summary_item":
      return t.commentsTargetSummaryItem
    case "action_item":
      return t.commentsTargetActionItem
    case "clip":
      return t.commentsTargetClip
    case "chapter":
      return t.commentsTargetChapter
    default:
      return t.commentsTargetMeeting
  }
}

export function CommentsDrawer({ meetingId, open, onOpenChange }: CommentsDrawerProps) {
  const { t } = useCollabStrings()
  const state = useMeetingComments(meetingId)
  const player = usePlayer()
  const [filter, setFilter] = useState<Filter>("open")

  const threads = useMemo(() => {
    const all = Object.values(state.snapshot?.threads ?? {}).flat()

    return all
      .filter((thread) =>
        filter === "all" ? true : filter === "open" ? !thread.resolvedAt : Boolean(thread.resolvedAt)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [filter, state.snapshot])

  const renderContext = (thread: CommentThread) => {
    const seekable =
      thread.targetType === "segment" && !thread.orphaned && thread.anchor.startMs !== undefined

    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-3">
        <span className="font-medium text-fg-2">{targetLabel(t, thread.targetType)}</span>
        {seekable ? (
          <CitationChip
            seconds={(thread.anchor.startMs ?? 0) / 1000}
            label={t.commentsJumpTo.replace("{time}", "").trim()}
            onClick={() => player.seek(thread.anchor.startMs ?? 0, { play: true, segmentId: thread.targetId })}
          />
        ) : null}
        {thread.orphaned ? <span className="text-warn-text">{t.commentsOrphaned}</span> : null}
        {thread.anchor.quote ? (
          <q dir="auto" className="line-clamp-2 basis-full text-fg-3">
            {thread.anchor.quote}
          </q>
        ) : null}
      </div>
    )
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="end" className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b border-line">
          <SheetTitle>{t.commentsTitle}</SheetTitle>
          <ToggleGroup
            value={[filter]}
            onValueChange={(value: unknown[]) => {
              const next = value[0]

              if (next === "open" || next === "resolved" || next === "all") setFilter(next)
            }}
            className="mt-2"
          >
            <ToggleGroupItem value="open" size="sm">
              {t.commentsFilterOpen}
            </ToggleGroupItem>
            <ToggleGroupItem value="resolved" size="sm">
              {t.commentsFilterResolved}
            </ToggleGroupItem>
            <ToggleGroupItem value="all" size="sm">
              {t.commentsFilterAll}
            </ToggleGroupItem>
          </ToggleGroup>
        </SheetHeader>
        <div className="ms-scrollbar grid flex-1 content-start gap-3 overflow-y-auto p-4">
          {state.status === "error" ? (
            <p className="text-sm text-danger-text">
              {state.error?.code === "user_required" ? t.commentsUserRequired : t.commentsLoadFailed}
            </p>
          ) : threads.length ? (
            threads.map((thread) => (
              <div key={thread.id} className="grid gap-1.5">
                {renderContext(thread)}
                <CommentThreadView meetingId={meetingId} thread={thread} snapshot={state.snapshot} />
              </div>
            ))
          ) : state.status === "ready" ? (
            <p className="text-sm text-fg-3">{t.commentsEmpty}</p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
