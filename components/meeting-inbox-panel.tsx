import {
  CalendarDaysIcon,
  FilterIcon,
  SearchIcon,
  SlidersHorizontalIcon,
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

const quickFilters = ["all", "usable", "processing", "failed", "upcoming"] as const

export type MeetingSortMode = MeetingListSortMode

const sortLabels: Record<MeetingSortMode, string> = {
  smart: "Smart",
  recent: "Recent",
  oldest: "Oldest",
  title: "Title",
  status: "Status",
}

function sourceMeta(source: MeetingRecord["source"]) {
  if (source === "google_meet") return { label: "Google Meet", dot: "bg-emerald-500", icon: "M" }
  if (source === "upload") return { label: "My Drive", dot: "bg-sky-500", icon: "D" }
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

  return (
    <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden border-r border-[var(--divider)] bg-[var(--surface)]">
      <div className="border-b border-[var(--divider)] px-4 py-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <CalendarDaysIcon aria-hidden="true" className="size-4 text-muted-foreground" />
            {dictionary.navMeetings}
          </h2>
          <span className="font-mono text-xs text-muted-foreground">
            {page.total}
          </span>
        </div>
        <div className="mb-3 flex items-center gap-2">
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
        <div className="mb-3 flex h-10 items-center gap-2 rounded-md border border-[var(--divider)] bg-[var(--surface-subtle)] px-3">
          <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={dictionary.commandPlaceholder}
            className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {quickFilters.map((filter) => (
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
                    ? "h-7 justify-center rounded-sm bg-[var(--selected)] px-3 capitalize text-[var(--primary)]"
                    : "h-7 justify-center rounded-sm border-[var(--divider)] px-3 capitalize text-muted-foreground"
                }
              >
                {filter === "all"
                  ? dictionary.all
                  : filter === "usable"
                    ? "Ready"
                    : filter === "processing"
                      ? "Processing"
                      : filter === "failed"
                        ? "Failed"
                        : "Upcoming"}
              </Badge>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 overflow-y-auto bg-[var(--surface-subtle)] p-3 lg:max-h-none">
        <div className={loading ? "grid gap-2 opacity-60" : "grid gap-2"}>
          {!loading && meetings.length === 0 && (
            <div className="rounded-md border border-dashed border-[var(--divider)] bg-[var(--surface)] p-5 text-center text-sm text-muted-foreground">
              No meetings match this view.
            </div>
          )}
          {meetings.map((meeting) => {
            const source = sourceMeta(meeting.source)
            const selected = selectedMeetingId === meeting.id

            return (
              <button
                key={meeting.id}
                type="button"
                data-selected={selected}
                className="grid min-h-[108px] gap-2 rounded-md border border-[var(--divider)] bg-[var(--surface)] p-3 text-left shadow-[0_1px_0_rgba(15,23,42,0.02)] transition hover:border-[var(--focus)] hover:bg-[var(--selected)]/60 data-[selected=true]:border-[var(--focus)] data-[selected=true]:bg-[var(--selected)] rtl:text-right"
                onClick={() => onSelectMeeting(meeting.id)}
              >
                <div className="flex items-start gap-3">
                  <div className="grid size-8 shrink-0 place-items-center rounded-md bg-[var(--surface-subtle)] text-sm font-semibold shadow-sm ring-1 ring-[var(--divider)]">
                    {source.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="truncate text-sm font-semibold text-foreground">
                        {meeting.title}
                      </h3>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatter.format(new Date(meeting.startedAt))}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className={`size-2 rounded-full ${source.dot}`} />
                      <span className="truncate">{source.label}</span>
                      <span className="ms-auto size-2 rounded-full bg-teal-600" />
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      {durationLabel(meeting)} · {meeting.participants.length || 1} participants
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {(meeting.tags?.slice(0, 2) ?? ["review"]).map((tag) => (
                        <Badge
                          key={tag}
                          variant="secondary"
                          className={`h-6 rounded-sm px-2 text-[11px] font-medium ${tagClass(tag)}`}
                        >
                          {tag}
                        </Badge>
                      ))}
                      {(meeting.tags?.length ?? 0) > 2 && (
                        <Badge
                          variant="secondary"
                          className="h-6 rounded-sm bg-[var(--selected)] px-2 text-[11px] text-[var(--primary)]"
                        >
                          +{(meeting.tags?.length ?? 0) - 2}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--divider)] bg-[var(--surface)] px-4 py-3 text-xs text-muted-foreground">
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
        <span className="font-mono">
          Showing {showingStart}-{showingEnd} of {page.total}
        </span>
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
