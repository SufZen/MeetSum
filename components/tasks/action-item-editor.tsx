"use client"

/**
 * The meeting's action items (M5 B8; owner: Package B). Inline title edit,
 * owner combobox (meeting people → members → free text), due date (date
 * input, chips, or a phrase like "עד יום ראשון" previewed live), priority,
 * delete, "+ משימה", the cited source moment and C's comment anchor.
 *
 * Every edit is applied optimistically and rolled back with a message if
 * the server refuses it.
 */
import { useState } from "react"
import { PlusIcon } from "lucide-react"

import {
  createActionItem,
  deleteActionItem,
  patchActionItem,
} from "@/components/tasks/api"
import { TaskItemRow } from "@/components/tasks/task-item-row"
import { Button } from "@/components/ui/button"
import { getTasksMessages, type TasksMessages } from "@/lib/i18n/m5/tasks"
import type {
  ActionItem,
  ActionItemPatch,
  MeetingParticipant,
  MeetingSpeaker,
} from "@/lib/meetings/repository"
import { localDateIn } from "@/lib/tasks/due-date"
import type { TaskMember } from "@/lib/tasks/types"

export type ActionItemEditorProps = {
  meetingId: string
  items: ActionItem[]
  participants: MeetingParticipant[]
  speakers: MeetingSpeaker[]
  members: TaskMember[]
  /** ISO datetime; anchor for relative due phrases. */
  meetingStartedAt: string
  onChanged?: (items: ActionItem[]) => void
  /** UI locale for the strings (`he` → Hebrew). A dictionary wins. */
  locale?: string
  /** Any object carrying the task strings (e.g. the app `Dictionary`). */
  dictionary?: TasksMessages
  /** The meeting's primary language: sets the task text direction. */
  language?: string
  /** False for viewers: rows render read-only. */
  canEdit?: boolean
}

function directionOf(language: string | undefined): "rtl" | "ltr" | undefined {
  const code = language?.toLowerCase().split(/[-_]/)[0]

  if (!code || code === "mixed" || code === "auto" || code === "unknown") return undefined
  return code === "he" || code === "ar" || code === "fa" || code === "ur" ? "rtl" : "ltr"
}

/** Optimistic local view of a patch (the server answer replaces it). */
function applyLocally(item: ActionItem, patch: ActionItemPatch): ActionItem {
  const next: ActionItem = { ...item }

  if (patch.title !== undefined) next.title = patch.title
  if (patch.status !== undefined) next.status = patch.status
  if (patch.priority !== undefined) next.priority = patch.priority
  if (patch.ownerText !== undefined) next.owner = patch.ownerText ?? undefined
  if (patch.dueOn !== undefined) next.dueOn = patch.dueOn ?? undefined
  if (patch.status === undefined) next.editedByUser = true

  return next
}

export function ActionItemEditor({
  meetingId,
  items: initialItems,
  participants,
  speakers,
  members,
  meetingStartedAt,
  onChanged,
  locale,
  dictionary,
  language,
  canEdit = true,
}: ActionItemEditorProps) {
  const strings = dictionary ?? getTasksMessages(locale)
  const dir = directionOf(language)
  const [items, setItems] = useState(initialItems)
  const [syncedFrom, setSyncedFrom] = useState(initialItems)
  const [error, setError] = useState<string>()
  const [adding, setAdding] = useState(false)
  const [newTitle, setNewTitle] = useState("")
  const [today] = useState(() => localDateIn(new Date()))

  // New items from the parent (e.g. after regeneration) replace local state.
  if (initialItems !== syncedFrom) {
    setSyncedFrom(initialItems)
    setItems(initialItems)
  }

  function commit(next: ActionItem[]) {
    setItems(next)
    onChanged?.(next)
  }

  async function patchItem(item: ActionItem, patch: ActionItemPatch) {
    const before = items

    setError(undefined)
    commit(items.map((entry) => (entry.id === item.id ? applyLocally(entry, patch) : entry)))
    try {
      const saved = await patchActionItem(meetingId, item.id, patch)

      setItems((current) => {
        const next = current.map((entry) => (entry.id === saved.id ? saved : entry))

        onChanged?.(next)
        return next
      })
    } catch {
      commit(before)
      setError(strings.tasksSaveError)
    }
  }

  async function removeItem(item: ActionItem) {
    const before = items

    setError(undefined)
    commit(items.filter((entry) => entry.id !== item.id))
    try {
      await deleteActionItem(meetingId, item.id)
    } catch {
      commit(before)
      setError(strings.tasksSaveError)
    }
  }

  async function addItem() {
    const title = newTitle.trim()

    if (!title) return
    setError(undefined)
    try {
      const created = await createActionItem(meetingId, { title })

      commit([...items, created])
      setNewTitle("")
      setAdding(false)
    } catch {
      setError(strings.tasksSaveError)
    }
  }

  return (
    <section className="grid gap-2" aria-label={strings.navTasks}>
      {error ? (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">
          {error}
        </p>
      ) : null}
      {items.length ? (
        <ul className="grid gap-2">
          {items.map((item) => (
            <TaskItemRow
              key={item.id}
              item={item}
              meetingId={meetingId}
              meetingStartedAt={meetingStartedAt}
              dir={dir}
              strings={strings}
              participants={participants}
              speakers={speakers}
              members={members}
              today={today}
              onPatch={canEdit ? (patch) => patchItem(item, patch) : async () => {}}
              onDelete={canEdit ? () => removeItem(item) : undefined}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg-3">{strings.tasksEmptyMeeting}</p>
      )}
      {canEdit ? (
        adding ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void addItem()
            }}
          >
            <input
              autoFocus
              dir="auto"
              aria-label={strings.tasksTaskLabel}
              placeholder={strings.tasksNewPlaceholder}
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setAdding(false)
                  setNewTitle("")
                }
              }}
              className="h-8 min-w-0 flex-1 rounded-md border border-line-control bg-surface px-2.5 text-md text-fg outline-none placeholder:text-fg-3 focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25 focus-visible:outline-2 focus-visible:outline-transparent"
            />
            <Button type="submit" size="sm" disabled={!newTitle.trim()}>
              {strings.tasksSave}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setAdding(false)
                setNewTitle("")
              }}
            >
              {strings.tasksCancel}
            </Button>
          </form>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="justify-self-start"
            onClick={() => setAdding(true)}
          >
            <PlusIcon data-icon="inline-start" aria-hidden />
            {strings.tasksAdd.replace(/^\+\s*/, "")}
          </Button>
        )
      ) : null}
    </section>
  )
}
