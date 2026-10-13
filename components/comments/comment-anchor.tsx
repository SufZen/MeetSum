"use client"

/**
 * Comment entry point on one target (M5 C5): an icon button with the live
 * comment count that opens a popover with the target's threads and a
 * composer (with @-mentions). Hidden for principals that cannot comment.
 */
import { useState } from "react"
import { MessageSquareIcon } from "lucide-react"
import { toast } from "sonner"

import { CommentComposer } from "@/components/comments/comment-composer"
import {
  collabApi,
  commentCount,
  formatMessage,
  refreshComments,
  threadsFor,
  useCollabStrings,
  useMeetingComments,
} from "@/components/comments/collab-client"
import { CommentThreadView } from "@/components/comments/comment-thread"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import type { CommentAnchor as CommentAnchorPosition, CommentTargetType } from "@/lib/comments/types"
import { cn } from "@/lib/utils"

export type CommentAnchorProps = {
  meetingId: string
  targetType: CommentTargetType
  targetId: string
  /** Kept for API compatibility; the server derives the stored anchor. */
  anchor?: CommentAnchorPosition
  /** Count override (otherwise from the shared comments snapshot). */
  count?: number
  className?: string
}

export function CommentAnchor({ meetingId, targetType, targetId, count, className }: CommentAnchorProps) {
  const { t } = useCollabStrings()
  const state = useMeetingComments(meetingId)
  const [open, setOpen] = useState(false)
  const threads = threadsFor(state.snapshot, targetType, targetId)
  const total = count ?? commentCount(threads)

  if (state.status === "error" && state.error?.code === "user_required") return null

  const label = total ? formatMessage(t.commentsCount, { count: total }) : t.commentsAdd

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size={total ? "xs" : "icon-xs"}
            aria-label={label}
            title={label}
            className={cn("text-fg-3", total > 0 && "text-fg-2", className)}
          />
        }
      >
        <MessageSquareIcon />
        {total ? (
          <span className="font-mono tabular-nums [direction:ltr] [unicode-bidi:isolate]">{total}</span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] gap-3">
        <PopoverTitle className="text-sm font-semibold">{t.commentsTitle}</PopoverTitle>
        {threads.length ? (
          <div className="ms-scrollbar grid max-h-80 gap-2 overflow-y-auto">
            {threads.map((thread) => (
              <CommentThreadView
                key={thread.id}
                meetingId={meetingId}
                thread={thread}
                snapshot={state.snapshot}
              />
            ))}
          </div>
        ) : state.status === "error" ? (
          <p className="text-sm text-danger-text">{t.commentsLoadFailed}</p>
        ) : null}
        <CommentComposer
          autoFocus={!threads.length}
          onSubmit={async (body) => {
            try {
              await collabApi.createComment(meetingId, { targetType, targetId, body })
              await refreshComments(meetingId)
            } catch {
              toast.error(t.commentsFailed)
              throw new Error("comment failed")
            }
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
