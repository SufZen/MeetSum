import { Progress } from "@/components/ui/progress"
import { StatusBadge } from "@/components/status-badge"
import { MEETING_STATUS_FLOW } from "@/lib/meetings/state"
import type { MeetingRecord } from "@/lib/meetings/repository"
import type { SupportedLocale } from "@/lib/i18n/locales"

const statusProgress = new Map(
  MEETING_STATUS_FLOW.map((status, index) => [
    status,
    Math.round((index / (MEETING_STATUS_FLOW.length - 2)) * 100),
  ])
)

export function MeetingList({
  meetings,
  locale,
}: {
  meetings: MeetingRecord[]
  locale: SupportedLocale
}) {
  const formatter = new Intl.DateTimeFormat(locale === "he" ? "he-IL" : locale, {
    dateStyle: "medium",
    timeStyle: "short",
  })

  return (
    <div className="flex flex-col gap-2">
      {meetings.map((meeting, index) => (
        <article
          key={meeting.id}
          className="grid min-h-32 gap-3 rounded-md border bg-card p-3 shadow-sm transition-colors data-[selected=true]:border-primary/50 data-[selected=true]:bg-primary/5"
          data-selected={index === 0}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold">{meeting.title}</h3>
              <p className="text-xs text-muted-foreground">
                {formatter.format(new Date(meeting.startedAt))}
              </p>
            </div>
            <StatusBadge status={meeting.status} />
          </div>
          <Progress value={statusProgress.get(meeting.status) ?? 0} />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{meeting.source.replaceAll("_", " ")}</span>
            <span>{meeting.language.toUpperCase()}</span>
          </div>
        </article>
      ))}
    </div>
  )
}
