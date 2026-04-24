import {
  CalendarDaysIcon,
  ChevronDownIcon,
  FilterIcon,
  SearchIcon,
  SlidersHorizontalIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"
import type { MeetingRecord } from "@/lib/meetings/repository"

const quickFilters = ["all", "my meetings", "rooms"]

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

export function MeetingInboxPanel({
  dictionary,
  locale,
  meetings,
  selectedMeetingId,
  query,
  activeFilter,
  onQueryChange,
  onFilterChange,
  onSelectMeeting,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
  meetings: MeetingRecord[]
  selectedMeetingId?: string
  query: string
  activeFilter: string
  onQueryChange: (value: string) => void
  onFilterChange: (value: string) => void
  onSelectMeeting: (meetingId: string) => void
}) {
  const formatter = new Intl.DateTimeFormat(locale === "he" ? "he-IL" : locale, {
    hour: "numeric",
    minute: "2-digit",
  })

  return (
    <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-r bg-white">
      <div className="border-b px-4 py-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <CalendarDaysIcon aria-hidden="true" className="size-4 text-slate-500" />
            {dictionary.navMeetings}
          </h2>
          <span className="font-mono text-xs text-slate-500">{meetings.length}</span>
        </div>
        <div className="mb-3 flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-8 justify-start px-2">
            <FilterIcon data-icon="inline-start" className="size-4 text-slate-500" />
            Filter
          </Button>
          <Button variant="ghost" size="sm" className="ms-auto h-8 px-2">
            <SlidersHorizontalIcon data-icon="inline-start" className="size-4 text-slate-500" />
            Sort: Recent
            <ChevronDownIcon aria-hidden="true" className="size-3" />
          </Button>
        </div>
        <div className="mb-3 flex h-10 items-center gap-2 rounded-md border bg-white px-3">
          <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-slate-400" />
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
              onClick={() => onFilterChange(filter === "all" ? "all" : activeFilter)}
              className="rounded-sm"
            >
              <Badge
                variant={filter === "all" ? "secondary" : "outline"}
                className={
                  filter === "my meetings"
                    ? "h-7 justify-center rounded-sm bg-cyan-50 px-3 capitalize text-teal-700"
                    : "h-7 justify-center rounded-sm px-3 capitalize"
                }
              >
                {filter}
                {filter === "rooms" && (
                  <ChevronDownIcon aria-hidden="true" className="size-3" />
                )}
              </Badge>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 overflow-y-auto p-3">
        <div className="grid gap-2">
          {meetings.map((meeting) => {
            const source = sourceMeta(meeting.source)
            const selected = selectedMeetingId === meeting.id

            return (
              <button
                key={meeting.id}
                type="button"
                data-selected={selected}
                className="grid min-h-[112px] gap-2 rounded-md border bg-white p-3 text-left transition hover:border-teal-300 hover:bg-cyan-50/30 data-[selected=true]:border-teal-400 data-[selected=true]:bg-cyan-50/60 rtl:text-right"
                onClick={() => onSelectMeeting(meeting.id)}
              >
                <div className="flex items-start gap-3">
                  <div className="grid size-8 shrink-0 place-items-center rounded-md bg-white text-sm font-semibold shadow-sm ring-1 ring-slate-200">
                    {source.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="truncate text-sm font-semibold text-slate-950">
                        {meeting.title}
                      </h3>
                      <span className="shrink-0 text-xs text-slate-600">
                        {formatter.format(new Date(meeting.startedAt))}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-slate-600">
                      <span className={`size-2 rounded-full ${source.dot}`} />
                      <span className="truncate">{source.label}</span>
                      <span className="ms-auto size-2 rounded-full bg-teal-600" />
                    </div>
                    <div className="mt-2 text-xs text-slate-600">
                      {durationLabel(meeting)} · {meeting.participants.length || 1} participants
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {(meeting.tags?.slice(0, 2) ?? ["review"]).map((tag) => (
                        <Badge
                          key={tag}
                          variant="secondary"
                          className="h-6 rounded-sm bg-slate-100 px-2 text-[11px] font-medium text-slate-700"
                        >
                          {tag}
                        </Badge>
                      ))}
                      {(meeting.tags?.length ?? 0) > 2 && (
                        <Badge
                          variant="secondary"
                          className="h-6 rounded-sm bg-cyan-100 px-2 text-[11px] text-teal-700"
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
    </section>
  )
}
