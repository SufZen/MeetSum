import {
  CalendarDaysIcon,
  SearchIcon,
  SlidersHorizontalIcon,
} from "lucide-react"

import { BotStatusPill } from "@/components/bot/bot-status-pill"
import { botPillFor, pickInboxPill, type BotPill } from "@/components/bot/bot-ui-state"
import type { BotSessionsMap } from "@/components/bot/use-bot-sessions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { StatusPill } from "@/components/ui/meeting-atoms"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"
import type {
  MeetingListItem,
  MeetingListSortMode,
} from "@/lib/meetings/repository"
import { formatDurationLabel, getMeetingDurationMs } from "@/lib/meetings/duration"

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

function isDriveImport(meeting: MeetingListItem) {
  return Boolean(meeting.mediaAssets?.some((asset) => asset.source === "google_drive"))
}

function sourceMeta(meeting: MeetingListItem) {
  const source = meeting.source

  if (source === "upload" && isDriveImport(meeting)) {
    return { label: "Drive import", dot: "bg-info", icon: "D" }
  }
  if (source === "google_meet") return { label: "Google Meet", dot: "bg-ok", icon: "G" }
  if (source === "upload") return { label: "Upload", dot: "bg-info", icon: "U" }
  if (source === "pwa_recorder") return { label: "Recorder", dot: "bg-brand", icon: "R" }
  if (source === "desktop_recorder") return { label: "Desktop", dot: "bg-fg-3", icon: "D" }
  if (source === "meeting_bot") return { label: "MeetSum bot", dot: "bg-brand", icon: "B" }
  return { label: source.replaceAll("_", " "), dot: "bg-warn", icon: "A" }
}

function participantCount(meeting: MeetingListItem) {
  return meeting.participantDetails?.length || meeting.participants.length
}

function tagClass(tag: string) {
  if (/(urgent|follow|review|action|task)/i.test(tag)) {
    return "bg-warn-soft text-warn-text"
  }
  if (/(ai|mixed|hebrew|english|portuguese|spanish|italian)/i.test(tag)) {
    return "bg-surface-3 text-fg-2"
  }
  if (/(technical|product|mcp|gemini|gemma|realizeos)/i.test(tag)) {
    return "bg-info-soft text-info-text"
  }

  return "bg-brand-soft text-brand-text"
}

/**
 * Inbox pills are for exceptions only (README §7): a finished, scheduled or
 * just-created meeting gets no pill. Processing shows the step, never an
 * invented percentage.
 */
function statusPill(
  status: MeetingListItem["status"]
): { status: "failed" | "processing"; label: string } | null {
  if (status === "failed") return { status: "failed", label: "Failed" }
  if (status === "completed" || status === "scheduled" || status === "created") return null

  return { status: "processing", label: "Processing" }
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
  botSessions,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
  meetings: MeetingListItem[]
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
  /** M7: newest bot session per meeting (empty when the bot is disabled). */
  botSessions?: BotSessionsMap
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
    <section className="ms-no-x grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] border-e border-line bg-surface">
      <div className="ms-no-x border-b border-line px-3 py-3">
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
          <label className="ms-auto flex h-8 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground">
              <SlidersHorizontalIcon data-icon="inline-start" className="size-4 text-muted-foreground" />
              <span className="sr-only">Sort meetings</span>
              <select
                value={sortMode}
                onChange={(event) => onSortChange(event.target.value as MeetingSortMode)}
                className="h-8 rounded-sm border border-transparent bg-transparent px-1 text-sm font-medium text-foreground outline-none hover:border-line focus:border-ring focus:ring-2 focus:ring-ring/20"
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
        <div className="mb-2.5 flex h-8 items-center gap-2 rounded-md border border-line bg-surface-2 px-3">
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
              className="rounded-sm focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent"
            >
              <Badge
                variant={activeFilter === filter ? "secondary" : "outline"}
                className={
                  activeFilter === filter
                    ? "h-7 w-full justify-center rounded-md bg-brand-soft px-1.5 text-brand-text"
                    : "h-7 w-full justify-center rounded-md border-line px-1.5 text-muted-foreground"
                }
              >
                {filter === "all" ? dictionary.all : label === "Processing" ? "Process" : label}
              </Badge>
            </button>
          ))}
        </div>
      </div>

      <div className="ms-scrollbar ms-no-x min-h-0 overflow-y-auto bg-surface-2 p-2.5 lg:max-h-none">
        <div className={loading ? "grid gap-2 opacity-60" : "grid gap-2"}>
          {!loading && meetings.length === 0 && (
            <div className="rounded-md border border-dashed border-line bg-surface p-5 text-center text-sm text-muted-foreground">
              No meetings match this view.
            </div>
          )}
          {meetingRows.map(({ meeting, group, showGroup }) => {
            const source = sourceMeta(meeting)
            const selected = selectedMeetingId === meeting.id
            const started = new Date(meeting.startedAt)
            const meetingPill = statusPill(meeting.status)
            const botSession = botSessions?.[meeting.id]
            const botPill = botSession ? botPillFor(botSession.status, botSession.statusReason) : null
            // One pill per row: live > review > failed > processing.
            const pill = pickInboxPill<
              { status: BotPill["status"]; bot?: BotPill; label?: string }
            >(
              botPill ? { status: botPill.status, bot: botPill } : null,
              meetingPill ? { status: meetingPill.status, label: meetingPill.label } : null
            )

            return (
              <div key={meeting.id} className="grid gap-2">
                {showGroup && (
                  <div className="flex items-center gap-2 px-1 pt-1 text-xs font-medium text-muted-foreground">
                    <span className="size-3 rounded border border-line bg-surface" />
                    {group}
                  </div>
                )}
                <button
                  type="button"
                  data-selected={selected}
                  className="ms-no-x grid min-h-19 gap-2 rounded-md border border-line bg-surface px-2.5 py-2.5 text-start shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition hover:border-ring hover:bg-brand-soft/50 data-[selected=true]:border-ring data-[selected=true]:bg-brand-soft"
                  onClick={() => onSelectMeeting(meeting.id)}
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <div className="grid size-7 shrink-0 place-items-center rounded-md bg-surface-2 text-xs font-semibold text-brand-text ring-1 ring-line">
                      {source.icon}
                    </div>
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                        <h3 dir="auto" className="ms-row-title text-sm font-semibold leading-5 text-foreground">
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
                        <span className="shrink-0 [unicode-bidi:isolate]">
                          {formatDurationLabel(getMeetingDurationMs(meeting), locale)}
                        </span>
                        <span>·</span>
                        <span className="min-w-0 truncate">
                          {participantCount(meeting)} {participantCount(meeting) === 1 ? "participant" : "participants"}
                        </span>
                      </div>
                      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1">
                        {pill?.bot ? (
                          <BotStatusPill pill={pill.bot} dictionary={dictionary} />
                        ) : pill?.label ? (
                          <StatusPill status={pill.status}>{pill.label}</StatusPill>
                        ) : null}
                        {(meeting.tags?.slice(0, 2) ?? []).map((tag) => (
                          <Badge
                            key={tag}
                            variant="secondary"
                            className={`h-5 max-w-28 truncate rounded-md px-1.5 text-2xs font-medium ${tagClass(tag)}`}
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

      <div className="ms-no-x grid gap-2 border-t border-line bg-surface px-3 py-2.5 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center justify-between gap-2">
        <label className="flex items-center gap-2">
          <span>Show</span>
          <select
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            className="h-8 rounded-sm border border-line bg-surface-2 px-2 text-sm font-medium text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
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
