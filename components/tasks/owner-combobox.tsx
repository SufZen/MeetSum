"use client"

/**
 * Owner picker for an action item (M5 B8): an ARIA combobox (listbox with
 * `aria-activedescendant`) grouping the meeting's people first (resolved
 * speaker / participant names), then workspace members, then the typed
 * text as a free-text owner. Names render in `<bdi dir="auto">`.
 */
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { XIcon } from "lucide-react"

import { withSlot } from "@/components/tasks/slot"
import { Button } from "@/components/ui/button"
import type { MeetingParticipant, MeetingSpeaker } from "@/lib/meetings/repository"
import type { TasksMessages } from "@/lib/i18n/m5/tasks"
import type { TaskMember } from "@/lib/tasks/types"
import { cn } from "@/lib/utils"

export type OwnerSelection = {
  ownerText: string | null
  ownerParticipantId: string | null
  ownerUserId: string | null
}

type OwnerOption = OwnerSelection & {
  key: string
  label: string
  detail?: string
  group: "meeting" | "members" | "free"
}

function normalize(value: string) {
  return value.normalize("NFKC").toLowerCase().trim()
}

/** People of the meeting (participants with speaker names), then members. */
export function buildOwnerOptions(
  participants: MeetingParticipant[],
  speakers: MeetingSpeaker[],
  members: TaskMember[]
): OwnerOption[] {
  const options: OwnerOption[] = []
  const memberByEmail = new Map(members.map((member) => [member.email.toLowerCase(), member]))
  const seenUsers = new Set<string>()
  const seenNames = new Set<string>()

  for (const participant of participants) {
    const speakerName = speakers.find((speaker) => speaker.participantId === participant.id)?.displayName
    const label = participant.name || speakerName || participant.email || ""

    if (!label) continue

    const member = participant.email ? memberByEmail.get(participant.email.toLowerCase()) : undefined

    if (member) seenUsers.add(member.userId)
    seenNames.add(normalize(label))
    options.push({
      key: `p:${participant.id}`,
      label,
      detail: participant.email,
      group: "meeting",
      ownerText: label,
      ownerParticipantId: participant.id,
      ownerUserId: member?.userId ?? null,
    })
  }

  // Confirmed speaker names that are not participants still count as people.
  for (const speaker of speakers) {
    const name = speaker.displayName?.trim()

    if (!name || speaker.participantId || seenNames.has(normalize(name))) continue
    seenNames.add(normalize(name))
    options.push({
      key: `s:${speaker.id}`,
      label: name,
      group: "meeting",
      ownerText: name,
      ownerParticipantId: null,
      ownerUserId: null,
    })
  }

  for (const member of members) {
    if (seenUsers.has(member.userId)) continue
    options.push({
      key: `u:${member.userId}`,
      label: member.name || member.email,
      detail: member.name ? member.email : undefined,
      group: "members",
      ownerText: member.name || member.email,
      ownerParticipantId: null,
      ownerUserId: member.userId,
    })
  }

  return options
}

export function OwnerCombobox({
  value,
  participants,
  speakers,
  members,
  strings,
  onSelect,
  disabled,
  className,
}: {
  /** Current display name. */
  value?: string
  participants: MeetingParticipant[]
  speakers: MeetingSpeaker[]
  members: TaskMember[]
  strings: TasksMessages
  onSelect: (selection: OwnerSelection) => void
  disabled?: boolean
  className?: string
}) {
  const id = useId()
  const listId = `${id}-list`
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const all = useMemo(
    () => buildOwnerOptions(participants, speakers, members),
    [participants, speakers, members]
  )
  const options = useMemo(() => {
    const needle = normalize(query)
    const matches = needle
      ? all.filter(
          (option) =>
            normalize(option.label).includes(needle) ||
            (option.detail ? normalize(option.detail).includes(needle) : false)
        )
      : all
    const exact = matches.some((option) => normalize(option.label) === needle)
    const free: OwnerOption[] =
      needle && !exact
        ? [
            {
              key: "free",
              label: query.trim(),
              group: "free",
              ownerText: query.trim(),
              ownerParticipantId: null,
              ownerUserId: null,
            },
          ]
        : []

    return [...matches, ...free]
  }, [all, query])

  function choose(option: OwnerOption | undefined) {
    if (!option) return
    onSelect({
      ownerText: option.ownerText,
      ownerParticipantId: option.ownerParticipantId,
      ownerUserId: option.ownerUserId,
    })
    setQuery("")
    setOpen(false)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setOpen(true)
      setActive((current) => (options.length ? (current + 1) % options.length : 0))
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setOpen(true)
      setActive((current) => (options.length ? (current - 1 + options.length) % options.length : 0))
    } else if (event.key === "Enter") {
      if (open && options.length) {
        event.preventDefault()
        choose(options[Math.min(active, options.length - 1)])
      }
    } else if (event.key === "Escape") {
      if (open) {
        event.preventDefault()
        setOpen(false)
      }
    }
  }

  const groups: Array<[OwnerOption["group"], string]> = [
    ["meeting", strings.tasksOwnerInMeeting],
    ["members", strings.tasksOwnerMembers],
    ["free", ""],
  ]
  const activeOption = open ? options[Math.min(active, options.length - 1)] : undefined

  return (
    <div className={cn("relative flex min-w-0 items-center gap-1", className)}>
      <input
        ref={inputRef}
        role="combobox"
        aria-label={strings.tasksOwner}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeOption ? `${id}-${activeOption.key}` : undefined}
        dir="auto"
        disabled={disabled}
        value={query}
        placeholder={value || strings.tasksOwnerPlaceholder}
        onChange={(event) => {
          setQuery(event.target.value)
          setActive(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className="h-7 w-full min-w-0 rounded-md border border-line-control bg-surface px-2 text-sm text-fg outline-none placeholder:text-fg-2 focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25 focus-visible:outline-2 focus-visible:outline-transparent disabled:bg-surface-2"
      />
      {value ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={strings.tasksOwnerClear}
          disabled={disabled}
          onClick={() => onSelect({ ownerText: null, ownerParticipantId: null, ownerUserId: null })}
        >
          <XIcon aria-hidden />
        </Button>
      ) : null}
      {open && options.length ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={strings.tasksOwner}
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-auto rounded-md border border-line bg-surface p-1 shadow-md animate-ms-pop-in"
        >
          {groups.map(([group, label]) => {
            const items = options.filter((option) => option.group === group)

            if (!items.length) return null

            return (
              <li key={group} role="presentation">
                {label ? (
                  <div className="px-2 pb-0.5 pt-1.5 text-2xs font-semibold text-fg-3">{label}</div>
                ) : null}
                <ul role="group" aria-label={label || undefined}>
                  {items.map((option) => {
                    const selected = option === activeOption

                    return (
                      <li
                        key={option.key}
                        id={`${id}-${option.key}`}
                        role="option"
                        aria-selected={selected}
                        // Keep focus in the input; choose on mouse down.
                        onMouseDown={(event) => {
                          event.preventDefault()
                          choose(option)
                        }}
                        onMouseEnter={() => setActive(options.indexOf(option))}
                        className={cn(
                          "flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1 text-sm text-fg",
                          selected && "bg-brand-soft text-brand-text"
                        )}
                      >
                        {option.group === "free" ? (
                          <span>
                            {withSlot(strings.tasksOwnerFreeText, "name", <bdi dir="auto">{option.label}</bdi>)}
                          </span>
                        ) : (
                          <bdi dir="auto" className="truncate">
                            {option.label}
                          </bdi>
                        )}
                        {option.detail ? (
                          <span dir="ltr" className="truncate text-xs text-fg-3">
                            <bdi>{option.detail}</bdi>
                          </span>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
