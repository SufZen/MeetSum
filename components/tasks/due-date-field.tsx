"use client"

/**
 * Due date editor (M5 B8): native date input, quick chips (today, tomorrow,
 * end of week, next week, end of month — relative to today), and a free-text
 * phrase ("עד יום ראשון") previewed live with the same parser the server
 * uses, anchored on the meeting start.
 */
import { useId, useMemo, useState } from "react"

import { Isolated, withSlot } from "@/components/tasks/slot"
import { Button } from "@/components/ui/button"
import type { TasksMessages } from "@/lib/i18n/m5/tasks"
import { formatDueDateDisplay, parseDueDate } from "@/lib/tasks/due-date"

export type DueChange = { dueOn: string | null } | { dueText: string }

/** Chip phrases are parsed (in Hebrew) relative to today. */
const CHIPS: Array<[keyof TasksMessages, string]> = [
  ["tasksChipToday", "היום"],
  ["tasksChipTomorrow", "מחר"],
  ["tasksChipEndOfWeek", "סוף השבוע"],
  ["tasksChipNextWeek", "שבוע הבא"],
  ["tasksChipEndOfMonth", "סוף החודש"],
]

export function chipDate(phrase: string, now: Date = new Date()): string | undefined {
  return parseDueDate(phrase, { anchor: now.toISOString() })?.date
}

export function DueDateField({
  dueOn,
  dueText,
  meetingStartedAt,
  strings,
  onChange,
  disabled,
}: {
  dueOn?: string
  dueText?: string
  /** Anchor for typed phrases (the server parses with the same anchor). */
  meetingStartedAt: string
  strings: TasksMessages
  onChange: (change: DueChange) => void
  disabled?: boolean
}) {
  const id = useId()
  const [phrase, setPhrase] = useState(dueText ?? "")
  const preview = useMemo(
    () => (phrase.trim() ? parseDueDate(phrase, { anchor: meetingStartedAt }) : null),
    [phrase, meetingStartedAt]
  )

  function commitPhrase() {
    const text = phrase.trim()

    if (text && text !== (dueText ?? "")) onChange({ dueText: text })
  }

  return (
    <fieldset className="grid min-w-0 gap-1.5" disabled={disabled}>
      <legend className="sr-only">{strings.tasksDue}</legend>
      <div className="flex flex-wrap items-center gap-1.5">
        <label htmlFor={`${id}-date`} className="text-xs text-fg-3">
          {strings.tasksDue}
        </label>
        <input
          id={`${id}-date`}
          type="date"
          value={dueOn ?? ""}
          onChange={(event) => onChange({ dueOn: event.target.value || null })}
          className="h-7 rounded-md border border-line-control bg-surface px-2 text-sm text-fg tabular-nums outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25 focus-visible:outline-2 focus-visible:outline-transparent"
        />
        {dueOn ? (
          <Button type="button" size="xs" variant="ghost" onClick={() => onChange({ dueOn: null })}>
            {strings.tasksDueClear}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label={strings.tasksDue}>
        {CHIPS.map(([key, chipPhrase]) => {
          const date = chipDate(chipPhrase)
          const pressed = Boolean(date && date === dueOn)

          return (
            <Button
              key={key}
              type="button"
              size="xs"
              variant="secondary"
              aria-pressed={pressed}
              className="aria-pressed:border-brand aria-pressed:bg-brand-soft aria-pressed:text-brand-text"
              disabled={!date}
              onClick={() => date && onChange({ dueOn: date })}
            >
              {strings[key]}
            </Button>
          )
        })}
      </div>
      <div className="grid gap-1">
        <label htmlFor={`${id}-phrase`} className="text-xs text-fg-3">
          {strings.tasksDuePhrase}
        </label>
        <input
          id={`${id}-phrase`}
          dir="auto"
          value={phrase}
          placeholder={strings.tasksDuePhrasePlaceholder}
          aria-describedby={`${id}-preview`}
          onChange={(event) => setPhrase(event.target.value)}
          onBlur={commitPhrase}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              commitPhrase()
            }
          }}
          className="h-7 w-full min-w-0 rounded-md border border-line-control bg-surface px-2 text-sm text-fg outline-none placeholder:text-fg-3 focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25 focus-visible:outline-2 focus-visible:outline-transparent"
        />
        <p id={`${id}-preview`} aria-live="polite" className="min-h-4 text-xs text-fg-3">
          {phrase.trim() ? (
            preview ? (
              <span>
                {withSlot(
                  strings.tasksDuePreview,
                  "date",
                  <Isolated>{formatDueDateDisplay(preview.date)}</Isolated>
                )}
              </span>
            ) : (
              <span className="text-warn-text">{strings.tasksDueUnparsed}</span>
            )
          ) : null}
        </p>
      </div>
    </fieldset>
  )
}
