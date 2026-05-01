import {
  CalendarIcon,
  ClockIcon,
  EllipsisIcon,
  Share2Icon,
  StarIcon,
  UsersIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { SupportedLocale } from "@/lib/i18n/locales"
import type { MeetingRecord } from "@/lib/meetings/repository"

function sourceLabel(source: MeetingRecord["source"]) {
  if (source === "google_meet") return "Google Meet"
  if (source === "pwa_recorder") return "Recorder"
  if (source === "upload") return "Upload"
  return source.replaceAll("_", " ")
}

function durationLabel(meeting: MeetingRecord) {
  const last = meeting.transcript?.at(-1)
  const minutes = last ? Math.max(62, Math.round(last.endMs / 60000)) : 62

  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
    : `${minutes}m`
}

export function MeetingHeader({
  meeting,
  locale,
}: {
  meeting: MeetingRecord
  locale: SupportedLocale
}) {
  const formatter = new Intl.DateTimeFormat(locale === "he" ? "he-IL" : locale, {
    dateStyle: "medium",
    timeStyle: "short",
  })
  const room = meeting.contexts?.[0]?.name ?? "Real Estate Acquisitions"

  return (
    <header className="border-b border-[var(--divider)] bg-[var(--surface)] px-5 py-5 md:px-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="rounded-md bg-[var(--selected)] text-[var(--primary)]">
              {sourceLabel(meeting.source)}
            </Badge>
            <h1 className="break-words text-xl font-semibold tracking-tight text-foreground md:text-[1.45rem]">
              {meeting.title}
            </h1>
            <StarIcon aria-hidden="true" className="size-4 text-amber-400" />
            <EllipsisIcon aria-hidden="true" className="size-5 text-muted-foreground" />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
            <span className="flex items-center gap-2">
              <CalendarIcon aria-hidden="true" className="size-4" />
              {formatter.format(new Date(meeting.startedAt))}
            </span>
            <span className="flex items-center gap-2">
              <ClockIcon aria-hidden="true" className="size-4" />
              {durationLabel(meeting)}
            </span>
            <span className="flex items-center gap-2">
              <UsersIcon aria-hidden="true" className="size-4" />
              {meeting.participants.length || 1} participants
            </span>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
            <span className="flex items-center gap-2 text-muted-foreground">
              <span className="size-2 rounded-full bg-emerald-500" />
              {room}
            </span>
            <Button variant="outline" size="sm" className="h-8 rounded-md border-[var(--divider)] bg-[var(--selected)] text-[var(--primary)]">
              Add to room
            </Button>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="h-9">
            <Share2Icon data-icon="inline-start" />
            Share
          </Button>
          <Button variant="outline" size="icon-sm" className="h-9 w-9">
            <EllipsisIcon aria-hidden="true" />
            <span className="sr-only">More</span>
          </Button>
        </div>
      </div>
    </header>
  )
}
