"use client"

/**
 * One action item (M5 B8), shared by the meeting's ActionItemEditor and the
 * cross-meeting Tasks page: check-off, inline title edit, owner / due /
 * priority editor, delete, the cited source moment (only when it resolves to
 * a real segment) and C's comment anchor. Editing an AI item makes it the
 * user's (`edited_by_user`), so reprocessing keeps it.
 */
import { useState } from "react"
import { PencilIcon, Trash2Icon } from "lucide-react"
import Link from "next/link"

import { CommentAnchor } from "@/components/comments/comment-anchor"
import { useMeetingPlayer } from "@/components/player/meeting-player-provider"
import { DueDateField, type DueChange } from "@/components/tasks/due-date-field"
import { OwnerCombobox, type OwnerSelection } from "@/components/tasks/owner-combobox"
import { Isolated } from "@/components/tasks/slot"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { CitationChip, StatusPill } from "@/components/ui/meeting-atoms"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type { TasksMessages } from "@/lib/i18n/m5/tasks"
import type {
  ActionItem,
  ActionItemPatch,
  MeetingParticipant,
  MeetingSpeaker,
} from "@/lib/meetings/repository"
import { usePlayer } from "@/lib/player/contract"
import { formatDueDateDisplay } from "@/lib/tasks/due-date"
import type { TaskMember } from "@/lib/tasks/types"
import { cn } from "@/lib/utils"

const PRIORITY_KEYS: Record<NonNullable<ActionItem["priority"]>, keyof TasksMessages> = {
  low: "tasksPriorityLow",
  normal: "tasksPriorityNormal",
  high: "tasksPriorityHigh",
  urgent: "tasksPriorityUrgent",
}

export function isOverdue(item: Pick<ActionItem, "status" | "dueOn">, today: string): boolean {
  return item.status === "open" && Boolean(item.dueOn && item.dueOn < today)
}

/** The cited moment, rendered only when it resolves to a transcript segment. */
function SourceChip({ item, label }: { item: ActionItem; label: string }) {
  const resolver = useMeetingPlayer()
  const player = usePlayer()
  const resolved = resolver.resolve({ segmentId: item.sourceSegmentId, startMs: item.sourceStartMs })

  if (!resolved) return null

  return (
    <CitationChip
      seconds={resolved.startMs / 1000}
      label={label}
      onClick={() => player.seek(resolved.startMs, { source: "action_item", segmentId: resolved.segmentId })}
    />
  )
}

export type TaskItemRowProps = {
  item: ActionItem
  meetingId: string
  meetingStartedAt: string
  strings: TasksMessages
  participants?: MeetingParticipant[]
  speakers?: MeetingSpeaker[]
  members: TaskMember[]
  /** `YYYY-MM-DD` in the task time zone. */
  today: string
  onPatch: (patch: ActionItemPatch) => Promise<void>
  onDelete?: () => Promise<void>
  /** Bulk selection (Tasks page). */
  selection?: { selected: boolean; onChange: (selected: boolean) => void }
  /** Meeting link (Tasks page). */
  meetingLink?: { href: string; title: string }
  /** Show the seekable source chip (inside a meeting player). */
  showSource?: boolean
  showComments?: boolean
}

export function TaskItemRow({
  item,
  meetingId,
  meetingStartedAt,
  strings,
  participants = [],
  speakers = [],
  members,
  today,
  onPatch,
  onDelete,
  selection,
  meetingLink,
  showSource = true,
  showComments = true,
}: TaskItemRowProps) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState(item.title)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const done = item.status === "done"
  const overdue = isOverdue(item, today)
  const detailsId = `task-details-${item.id}`

  async function run(action: () => Promise<void>) {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  function saveTitle() {
    const title = draftTitle.trim()

    setEditingTitle(false)
    if (title && title !== item.title) void run(() => onPatch({ title }))
    else setDraftTitle(item.title)
  }

  function onOwner(selection: OwnerSelection) {
    void run(() => onPatch(selection))
  }

  function onDue(change: DueChange) {
    void run(() => onPatch(change))
  }

  return (
    <li
      aria-busy={busy || undefined}
      className="grid gap-1.5 rounded-lg border border-line bg-surface px-3 py-2.5"
    >
      <div className="flex items-start gap-2.5">
        {selection ? (
          <Checkbox
            checked={selection.selected}
            onCheckedChange={(checked) => selection.onChange(Boolean(checked))}
            aria-label={strings.tasksSelect}
            className="mt-1"
          />
        ) : null}
        <Checkbox
          checked={done}
          onCheckedChange={() => void run(() => onPatch({ status: done ? "open" : "done" }))}
          aria-label={done ? strings.tasksMarkOpen : strings.tasksMarkDone}
          className="mt-1 rounded-full"
          disabled={busy}
        />
        <div className="grid min-w-0 flex-1 gap-0.5">
          {editingTitle ? (
            <input
              autoFocus
              dir="auto"
              aria-label={strings.tasksTaskLabel}
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              onBlur={saveTitle}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  saveTitle()
                } else if (event.key === "Escape") {
                  setDraftTitle(item.title)
                  setEditingTitle(false)
                }
              }}
              className="h-7 w-full min-w-0 rounded-md border border-line-control bg-surface px-2 text-md text-fg outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25 focus-visible:outline-2 focus-visible:outline-transparent"
            />
          ) : (
            <button
              type="button"
              dir="auto"
              onClick={() => {
                setDraftTitle(item.title)
                setEditingTitle(true)
              }}
              className={cn(
                "rounded-sm text-start text-md leading-6 text-fg outline-none focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent",
                done && "text-fg-3 line-through"
              )}
            >
              {item.title}
            </button>
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-3">
            <span>
              {item.owner ? <bdi dir="auto" className="text-fg-2">{item.owner}</bdi> : strings.tasksUnassigned}
            </span>
            {item.dueOn ? (
              <span className={cn(overdue && "text-warn-text")}>
                <Isolated>{formatDueDateDisplay(item.dueOn)}</Isolated>
              </span>
            ) : null}
            {item.priority && item.priority !== "normal" ? (
              <span>{strings[PRIORITY_KEYS[item.priority]]}</span>
            ) : null}
            {item.editedByUser && item.origin !== "user" ? <span>{strings.tasksEdited}</span> : null}
            {meetingLink ? (
              <Link
                href={meetingLink.href}
                className="min-w-0 truncate text-brand-text underline-offset-2 hover:underline"
                title={strings.tasksOpenMeeting}
              >
                <bdi dir="auto">{meetingLink.title}</bdi>
              </Link>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {overdue ? <StatusPill status="review">{strings.tasksOverdue}</StatusPill> : null}
          {showSource ? <SourceChip item={item} label={strings.tasksPlaySource} /> : null}
          {showComments ? (
            <CommentAnchor
              meetingId={meetingId}
              targetType="action_item"
              targetId={item.id}
              anchor={item.sourceStartMs !== undefined ? { startMs: item.sourceStartMs } : undefined}
            />
          ) : null}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={strings.tasksEditDetails}
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded((current) => !current)}
          >
            <PencilIcon aria-hidden />
          </Button>
          {onDelete ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={strings.tasksDelete}
              disabled={busy}
              onClick={() => void run(onDelete)}
            >
              <Trash2Icon aria-hidden />
            </Button>
          ) : null}
        </div>
      </div>
      {item.sourceQuote ? (
        <blockquote dir="auto" className="line-clamp-2 border-s-2 border-line ps-2 text-sm leading-5 text-fg-3">
          {item.sourceQuote}
        </blockquote>
      ) : null}
      {expanded ? (
        <div id={detailsId} className="grid gap-3 border-t border-line pt-2.5 sm:grid-cols-2">
          <div className="grid content-start gap-2">
            <div className="grid gap-1">
              <span className="text-xs text-fg-3">{strings.tasksOwner}</span>
              <OwnerCombobox
                value={item.owner}
                participants={participants}
                speakers={speakers}
                members={members}
                strings={strings}
                onSelect={onOwner}
                disabled={busy}
              />
            </div>
            <label className="grid gap-1">
              <span className="text-xs text-fg-3">{strings.tasksPriority}</span>
              <NativeSelect
                size="sm"
                value={item.priority ?? "normal"}
                disabled={busy}
                onChange={(event) =>
                  void run(() =>
                    onPatch({ priority: event.target.value as NonNullable<ActionItem["priority"]> })
                  )
                }
              >
                {(Object.keys(PRIORITY_KEYS) as Array<NonNullable<ActionItem["priority"]>>).map((priority) => (
                  <NativeSelectOption key={priority} value={priority}>
                    {strings[PRIORITY_KEYS[priority]]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          </div>
          <DueDateField
            dueOn={item.dueOn}
            dueText={item.dueSource === "user" ? item.dueText : undefined}
            meetingStartedAt={meetingStartedAt}
            strings={strings}
            onChange={onDue}
            disabled={busy}
          />
        </div>
      ) : null}
    </li>
  )
}
