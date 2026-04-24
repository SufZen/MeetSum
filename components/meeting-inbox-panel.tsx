import { FilterIcon, SearchIcon } from "lucide-react"

import { MeetingList } from "@/components/meeting-list"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"
import type { MeetingRecord } from "@/lib/meetings/repository"

const quickFilters = ["all", "completed", "scheduled", "failed"]

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
  return (
    <section className="grid min-h-0 gap-3">
      <div className="rounded-md border bg-card p-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">{dictionary.navMeetings}</h2>
            <p className="text-xs text-muted-foreground">
              {meetings.length} visible records
            </p>
          </div>
          <Badge variant="secondary" className="h-7 rounded-sm">
            <FilterIcon data-icon="inline-start" className="size-3" />
            filters
          </Badge>
        </div>
        <div className="flex h-10 items-center gap-2 rounded-md border bg-background px-3">
          <SearchIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={dictionary.commandPlaceholder}
            className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {quickFilters.map((filter) => (
            <button
              key={filter}
              type="button"
              onClick={() => onFilterChange(filter)}
              className="rounded-sm"
            >
              <Badge
                variant={activeFilter === filter ? "default" : "outline"}
                className="h-7 justify-center rounded-sm px-3 capitalize"
              >
                {filter}
              </Badge>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 overflow-y-auto pr-1 rtl:pr-0 rtl:pl-1">
        <MeetingList
          meetings={meetings}
          locale={locale}
          selectedMeetingId={selectedMeetingId}
          onSelectMeeting={onSelectMeeting}
        />
      </div>
    </section>
  )
}
