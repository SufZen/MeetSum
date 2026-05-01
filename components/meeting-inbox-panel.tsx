import {
  CalendarDaysIcon,
  FilterIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  CheckCircle2Icon,
  Clock3Icon,
  CircleAlertIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"
import type {
  MeetingListSortMode,
  MeetingRecord,
} from "@/lib/meetings/repository"

const quickFilters = [
  ["all", "All Meetings"],
  ["usable", "Ready"],
  ["favorites", "Favorites"],
  ["processing", "Processing"],
  ["failed", "Failed"],
  ["upcoming", "Upcoming"],
] as const

export type MeetingSortMode = MeetingListSortMode

const sortLabels: Record<MeetingSortMode, string> = {
  smart: "Smart",
  recent: "Recent",
  oldest: "Oldest",
  title: "Title",
  status: "Status",
}

function sourceMeta(source: MeetingRecord["source"]) {
  if (source === "google_meet") return { label: "Google Meet", dot: "bg-emerald-500", icon: "G" }
  if (source === "upload") return { label: "Drive import", dot: "bg-sky-500", icon: "D" }
  if (source === "pwa_recorder") return { label: "Recorder", dot: "bg-violet-500", icon: "R" }
  return { label: source.replaceAll("_", " "), dot: "bg-amber-500", icon: "A" }
}

function durationLabel(meeting: MeetingRecord) {
  const last = meeting.transcript?.at(-1)
  const minutes = last ? Math.max(62, Math.round(last.endMs / 60000)) : 48

  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
    : `${minutes}m`
}

function tagClass(tag: string) {
  if (/(urgent|follow|review|action|task)/i.test(tag)) {
    return "bg-[var(--tag-action)] text-[var(--tag-action-fg)]"
  }
  if (/(ai|mixed|hebrew|english|portuguese|spanish|italian)/i.test(tag)) {
    return "bg-[var(--tag-ai)] text-[var(--tag-ai-fg)]"
  }
  if (/(technical|product|mcp|gemini|gemma|realizeos)/i.test(tag)) {
    return "bg-[var(--tag-technical)] text-[var(--tag-technical-fg)]"
  }

  return "bg-[var(--tag-business)] text-[var(--tag-business-fg)]"
}

function statusMeta(status: MeetingRecord["status"]) {
  if (status === "completed") {
    return {
      label: "Ready",
      Icon: CheckCircle2Icon,
      className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-200",
    }
  }
  if (status === "failed") {
    return {
      label: "Failed",
      Icon: CircleAlertIcon,
      className: "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-200",
    }
  }
  if (status === "scheduled") {
    return {
      label: "Upcoming",
      Icon: Clock3Icon,
      className: "bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-200",
    }
  }

  return {
    label: "Processing",
    Icon: Clock3Icon,
    className: "bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200",
  }
}

function dateGroupLabel(date: Date) {
  const today = new Date()
  const yesterday = new Date()

  yesterday.setDate(today.getDate() - 1)

  const sameDay = (left: Date, right: Date) =>
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()

  if (sameDay(date, today)) return "Today"
  if (sameDay(date, yesterday)) return "Yesterday"

  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date)
}

export function MeetingInboxPanel({
  dictionary,
  locale,
  meetings,
  selectedMeetingId,
  query,
  activeFilter,
  sortMode,
  onQueryChange,
  onFilterChange,
  onSortChange,
  loading,
  page,
  pageSize,
  onPageSizeChange,
  onPreviousPage,
  onNextPage,
  onSelectMeeting,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
  meetings: MeetingRecord[]
  selectedMeetingId?: string
  query: string
  activeFilter: string
  sortMode: MeetingSortMode
  loading?: boolean
  page: {
    limit: number
    offset: number
    total: number
    hasMore: boolean
  }
  pageSize: number
  onQueryChange: (value: string) => void
  onFilterChange: (value: string) => void
  onSortChange: (value: MeetingSortMode) => void
  onPageSizeChange: (value: number) => void
  onPreviousPage: () => void
  onNextPage: () => void
  onSelectMeeting: (meetingId: string) => void
}) {
  const formatter = new Intl.DateTimeFormat(locale === "he" ? "he-IL" : locale, {
    hour: "numeric",
    minute: "2-digit",
  })
  const showingStart = page.total === 0 ? 0 : page.offset + 1
  const showingEnd = Math.min(page.offset + meetings.length, page.total)
  const meetingRows = meetings.map((meeting, index) => {
    const group = dateGroupLabel(new Date(meeting.startedAt))
    const previousGroup =
      index > 0 ? dateGroupLabel(new Date(meetings[index - 1].startedAt)) : ""

    return {
      meeting,
      group,
      showGroup: group !== previousGroup,
    }
  })

  return (
    <section className="ms-no-x grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] border-r border-[var(--divider)] bg-[var(--surface)]">
      <div className="ms-no-x border-b border-[var(--divider)] px-3 py-3">
        <div className="mb-2.5 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <CalendarDaysIcon aria-hidden="true" className="size-4 text-muted-foreground" />
            {dictionary.navMeetings}
          </h2>
          <span className="font-mono text-xs text-muted-foreground">
            {page.total}
          </span>
        </div>
        <div className="mb-2.5 flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-8 justify-start px-2">
            <FilterIcon data-icon="inline-start" className="size-4 text-muted-foreground" />
            {dictionary.filter}
          </Button>
          <label className="ms-auto flex h-8 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground">
              <SlidersHorizontalIcon data-icon="inline-start" className="size-4 text-muted-foreground" />
              <span className="sr-only">Sort meetings</span>
              <select
                value={sortMode}
                onChange={(event) => onSortChange(event.target.value as MeetingSortMode)}
                className="h-8 rounded-sm border border-transparent bg-transparent px-1 text-sm font-medium text-foreground outline-none hover:border-[var(--divider)] focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]/20"
                aria-label="Sort meetings"
              >
              {(Object.keys(sortLabels) as MeetingSortMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {sortLabels[mode]}
                </option>
              ))}
              </select>
          </label>
        </div>
        <div className="mb-2.5 flex h-8 items-center gap-2 rounded-md border border-[var(--divider)] bg-[var(--surface-subtle)] px-3">
          <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={dictionary.commandPlaceholder}
            className="h-7 min-w-0 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="ms-no-x grid grid-cols-3 gap-1 min-[390px]:grid-cols-6">
          {quickFilters.map(([filter, label]) => (
            <button
              key={filter}
              type="button"
              onClick={() => onFilterChange(filter)}
              className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
            >
              <Badge
                variant={activeFilter === filter ? "secondary" : "outline"}
                className={
                  activeFilter === filter
                    ? "h-7 w-full justify-center rounded-md bg-[var(--selected)] px-1.5 text-[var(--primary)]"
                    : "h-7 w-full justify-center rounded-md border-[var(--divider)] px-1.5 text-muted-foreground"
                }
              >
                {filter === "all" ? dictionary.all : label === "Processing" ? "Process" : label}
              </Badge>
            </button>
          ))}
        </div>
      </div>

      <div className="ms-scrollbar ms-no-x min-h-0 overflow-y-auto bg-[var(--surface-subtle)] p-2.5 lg:max-h-none">
        <div className={loading ? "grid gap-2 opacity-60" : "grid gap-2"}>
          {!loading && meetings.length === 0 && (
            <div className="rounded-md border border-dashed border-[var(--divider)] bg-[var(--surface)] p-5 text-center text-sm text-muted-foreground">
              No meetings match this view.
            </div>
          )}
          {meetingRows.map(({ meeting, group, showGroup }) => {
            const source = sourceMeta(meeting.source)
            const selected = selectedMeetingId === meeting.id
            const started = new Date(meeting.startedAt)
            const status = statusMeta(meeting.status)
            const StatusIcon = status.Icon

            return (
              <div key={meeting.id} className="grid gap-2">
                {showGroup && (
                  <div className="flex items-center gap-2 px-1 pt-1 text-xs font-medium text-muted-foreground">
                    <span className="size-3 rounded border border-[var(--divider)] bg-[var(--surface)]" />
                    {group}
                  </div>
                )}
                <button
                  type="button"
                  data-selected={selected}
                  className="ms-no-x grid min-h-[76px] gap-2 rounded-md border border-[var(--divider)] bg-[var(--surface)] px-2.5 py-2.5 text-left shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition hover:border-[var(--focus)] hover:bg-[var(--selected)]/50 data-[selected=true]:border-[var(--focus)] data-[selected=true]:bg-[var(--selected)] rtl:text-right"
                  onClick={() => onSelectMeeting(meeting.id)}
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <div className="grid size-7 shrink-0 place-items-center rounded-md bg-[var(--surface-subtle)] text-xs font-semibold text-[var(--primary)] ring-1 ring-[var(--divider)]">
                      {source.icon}
                    </div>
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                        <h3 className="ms-row-title text-sm font-semibold leading-5 text-foreground">
                          {meeting.title}
                        </h3>
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                          {formatter.format(started)}
                        </span>
                      </div>
                      <div className="mt-1 flex min-w-0 items-center gap-x-1.5 overflow-hidden text-xs text-muted-foreground">
                        <span className={`size-2 rounded-full ${source.dot}`} />
                        <span className="min-w-0 truncate">{source.label}</span>
                        <span>·</span>
                        <span className="shrink-0">{durationLabel(meeting)}</span>
                        <span>·</span>
                        <span className="min-w-0 truncate">{meeting.participants.length || 1} participants</span>
                      </div>
                      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1">
                        <span className={`inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium ${status.className}`}>
                          <StatusIcon aria-hidden="true" className="size-3" />
                          {status.label}
                        </span>
                        {(meeting.tags?.slice(0, 2) ?? []).map((tag) => (
                          <Badge
                            key={tag}
                            variant="secondary"
                            className={`h-5 max-w-[112px] truncate rounded-md px-1.5 text-[11px] font-medium ${tagClass(tag)}`}
                          >
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </div>
                </button>
              </div>
            )
          })}
        </div>
      </div>

      <div className="ms-no-x grid gap-2 border-t border-[var(--divider)] bg-[var(--surface)] px-3 py-2.5 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center justify-between gap-2">
        <label className="flex items-center gap-2">
          <span>Show</span>
          <select
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            className="h-8 rounded-sm border border-[var(--divider)] bg-[var(--surface-subtle)] px-2 text-sm font-medium text-foreground outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]/20"
            aria-label="Meetings per page"
          >
            {[5, 10, 20].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <span className="min-w-0 truncate font-mono">
          Showing {showingStart}-{showingEnd} of {page.total}
        </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-sm"
            disabled={page.offset === 0 || loading}
            onClick={onPreviousPage}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-sm"
            disabled={!page.hasMore || loading}
            onClick={onNextPage}
          >
            Next
          </Button>
        </div>
      </div>
    </section>
  )
}
