"use client"

/**
 * One comment thread (root + one level of replies), M5 C5. Bodies are plain
 * text rendered by React (escaped); mentions become `<bdi>` name chips.
 * User text has unknown language, so paragraphs use `dir="auto"`.
 */
import { useState } from "react"
import { CheckIcon, PencilIcon, RotateCcwIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { CommentComposer } from "@/components/comments/comment-composer"
import {
  authorName,
  collabApi,
  refreshComments,
  useCollabStrings,
  type CommentsSnapshot,
} from "@/components/comments/collab-client"
import { ReactionBar } from "@/components/comments/reaction-bar"
import { Button } from "@/components/ui/button"
import { useWorkspace } from "@/components/workspace-context"
import { mentionDisplayName, splitMentions } from "@/lib/comments/mentions"
import type { CommentThread as Thread, MeetingComment } from "@/lib/comments/types"
import { cn } from "@/lib/utils"

export function CommentBody({
  body,
  directory,
}: {
  body: string
  /** Member directory: mention chips show its names, not the author's text. */
  directory?: Readonly<Record<string, { name: string }>>
}) {
  return (
    <p dir="auto" className="whitespace-pre-wrap break-words text-sm text-fg-2">
      {splitMentions(body).map((part, index) =>
        part.type === "mention" ? (
          <bdi key={index} className="rounded-xs bg-brand-soft-2 px-0.5 font-medium text-brand-text">
            @{mentionDisplayName(part, directory)}
          </bdi>
        ) : (
          <span key={index}>{part.text}</span>
        )
      )}
    </p>
  )
}

function CommentItem({
  meetingId,
  comment,
  snapshot,
  canResolve,
  isRoot,
}: {
  meetingId: string
  comment: MeetingComment
  snapshot?: CommentsSnapshot
  canResolve: boolean
  isRoot: boolean
}) {
  const { t, locale } = useCollabStrings()
  const { role } = useWorkspace()
  const [editing, setEditing] = useState(false)
  const mine = comment.authorUserId === snapshot?.viewerUserId
  const canDelete = mine || role === "admin" || role === "owner"
  const created = new Date(comment.createdAt)
  const when = Number.isNaN(created.getTime())
    ? ""
    : new Intl.DateTimeFormat(locale === "he" ? "he-IL" : "en-GB", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(created)

  const run = async (action: () => Promise<unknown>, success?: string) => {
    try {
      await action()
      await refreshComments(meetingId)
      if (success) toast.success(success)
    } catch {
      toast.error(t.commentsFailed)
    }
  }

  if (comment.deletedAt) {
    return <p className="text-sm text-fg-3">{t.commentsTombstone}</p>
  }

  return (
    <div className="group/comment grid gap-1">
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-fg-3">
        <bdi className="font-semibold text-fg-2">{authorName(snapshot, comment.authorUserId)}</bdi>
        <span>{when}</span>
        {comment.editedAt ? <span>({t.commentsEditedBadge})</span> : null}
        {isRoot && comment.resolvedAt ? (
          <span className="rounded-full bg-ok-soft px-1.5 text-ok-text">{t.commentsResolved}</span>
        ) : null}
        <span className="ms-auto flex gap-0.5 opacity-0 transition-opacity duration-(--dur-1) group-focus-within/comment:opacity-100 group-hover/comment:opacity-100">
          {isRoot && canResolve ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={comment.resolvedAt ? t.commentsReopen : t.commentsResolve}
              title={comment.resolvedAt ? t.commentsReopen : t.commentsResolve}
              onClick={() => void run(() => collabApi.resolveComment(comment.id, !comment.resolvedAt))}
            >
              {comment.resolvedAt ? <RotateCcwIcon /> : <CheckIcon />}
            </Button>
          ) : null}
          {mine ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t.commentsEdit}
              title={t.commentsEdit}
              onClick={() => setEditing(true)}
            >
              <PencilIcon />
            </Button>
          ) : null}
          {canDelete ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t.commentsDelete}
              title={t.commentsDelete}
              onClick={() => void run(() => collabApi.deleteComment(comment.id), t.commentsDeleted)}
            >
              <Trash2Icon />
            </Button>
          ) : null}
        </span>
      </div>
      {editing ? (
        <CommentComposer
          autoFocus
          initialValue={comment.body}
          submitLabel={t.commentsSave}
          onCancel={() => setEditing(false)}
          onSubmit={async (body) => {
            await run(() => collabApi.editComment(comment.id, body))
            setEditing(false)
          }}
        />
      ) : (
        <CommentBody body={comment.body} directory={snapshot?.authors} />
      )}
      <ReactionBar meetingId={meetingId} targetType="comment" targetId={comment.id} />
    </div>
  )
}

export function CommentThreadView({
  meetingId,
  thread,
  snapshot,
  className,
}: {
  meetingId: string
  thread: Thread
  snapshot?: CommentsSnapshot
  className?: string
}) {
  const { t } = useCollabStrings()
  const { role } = useWorkspace()
  const [replying, setReplying] = useState(false)
  const canResolve = role !== undefined && role !== "viewer"

  return (
    <div
      className={cn(
        "grid gap-2 rounded-lg border border-line bg-surface p-3",
        thread.resolvedAt && "opacity-80",
        className
      )}
    >
      <CommentItem
        meetingId={meetingId}
        comment={thread}
        snapshot={snapshot}
        canResolve={canResolve}
        isRoot
      />
      {thread.replies.length ? (
        <div className="grid gap-2 border-s-2 border-line ps-3">
          {thread.replies.map((reply) => (
            <CommentItem
              key={reply.id}
              meetingId={meetingId}
              comment={reply}
              snapshot={snapshot}
              canResolve={false}
              isRoot={false}
            />
          ))}
        </div>
      ) : null}
      {!thread.deletedAt ? (
        replying ? (
          <CommentComposer
            autoFocus
            submitLabel={t.commentsReply}
            onCancel={() => setReplying(false)}
            onSubmit={async (body) => {
              try {
                await collabApi.createComment(meetingId, {
                  targetType: thread.targetType,
                  targetId: thread.targetId,
                  parentId: thread.id,
                  body,
                })
                await refreshComments(meetingId)
                setReplying(false)
              } catch (error) {
                toast.error(t.commentsFailed)
                throw error
              }
            }}
          />
        ) : (
          <Button variant="ghost" size="xs" className="justify-self-start" onClick={() => setReplying(true)}>
            {t.commentsReply}
          </Button>
        )
      ) : null}
    </div>
  )
}
