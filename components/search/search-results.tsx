"use client"

/**
 * Grouped search results (D1): one card per meeting, then its hits. Each hit
 * container takes `dir` from the hit language (`mixed` → the meeting
 * language, `auto` only when unknown); names and titles are `<bdi>`, the
 * timestamp is an LTR `<time>`. Clicking a hit opens the meeting at the
 * segment (`buildSegmentLink`).
 */
import Link from "next/link"

import { HighlightedText } from "@/components/search/highlighted-text"
import { formatTimecode } from "@/components/ui/meeting-atoms"
import { dirForLanguage, hitDir } from "@/lib/client/highlight"
import { formatMessage, type Dictionary } from "@/lib/i18n/dictionaries"
import { buildSegmentLink } from "@/lib/player/deep-link"
import type { ChunkKind, SearchHit, SearchMeetingGroup } from "@/lib/search/types"

export const KIND_KEYS: Record<ChunkKind, keyof Dictionary> = {
  transcript: "searchKindTranscript",
  summary: "searchKindSummary",
  item: "searchKindItem",
  action_item: "searchKindActionItem",
  chapter: "searchKindChapter",
  meta: "searchKindMeta",
}

export function formatMeetingDate(iso: string, locale: string): string {
  const date = new Date(iso)

  if (Number.isNaN(date.getTime())) return ""

  return new Intl.DateTimeFormat(locale === "he" ? "he-IL" : locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date)
}

export function hitHref(locale: string, meetingId: string, hit: Pick<SearchHit, "startMs">): string {
  return typeof hit.startMs === "number"
    ? buildSegmentLink({ locale, meetingId, ms: hit.startMs })
    : `/${locale}?${new URLSearchParams({ meeting: meetingId }).toString()}`
}

function HitRow({
  hit,
  group,
  locale,
  dictionary: t,
}: {
  hit: SearchHit
  group: SearchMeetingGroup
  locale: string
  dictionary: Dictionary
}) {
  const dir = hitDir(hit.language, group.meeting.language)
  const seconds = typeof hit.startMs === "number" ? hit.startMs / 1000 : undefined
  const time = seconds !== undefined ? formatTimecode(seconds) : undefined

  return (
    <li>
      <Link
        href={hitHref(locale, group.meeting.id, hit)}
        data-search-hit={hit.chunkId}
        className="group/hit grid gap-1 rounded-md px-3 py-2 transition-colors duration-(--dur-1) hover:bg-surface-3 focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent"
      >
        <span className="flex flex-wrap items-center gap-2 text-xs text-fg-3">
          {time ? (
            <time
              dir="ltr"
              dateTime={`PT${Math.floor(seconds ?? 0)}S`}
              aria-label={formatMessage(t.searchOpenAt, { time })}
              className="inline-flex h-5 items-center rounded-xs bg-surface-3 px-1.5 font-mono tabular-nums text-fg-2 [unicode-bidi:isolate] group-hover/hit:bg-brand-soft-2 group-hover/hit:text-brand-text"
            >
              {time}
            </time>
          ) : null}
          {hit.speakerName ? (
            <span className="font-medium text-fg-2">
              <bdi>{hit.speakerName}</bdi>
            </span>
          ) : null}
          <span className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-2xs">{t[KIND_KEYS[hit.kind] ?? "searchKindTranscript"]}</span>
        </span>
        <span dir={dir} lang={hit.language === "mixed" ? undefined : hit.language} data-search-snippet="" className="block text-base text-fg">
          <HighlightedText text={hit.snippet} ranges={hit.highlights ?? []} dir={dir} />
        </span>
      </Link>
    </li>
  )
}

export function MeetingResultCard({
  group,
  locale,
  dictionary: t,
}: {
  group: SearchMeetingGroup
  locale: string
  dictionary: Dictionary
}) {
  const { meeting } = group
  const titleDir = dirForLanguage(meeting.language)
  const meta = [
    ...meeting.rooms.map((room) => ({ key: `room-${room.id}`, label: room.name })),
    ...(meeting.meetingType ? [{ key: "type", label: meeting.meetingType }] : []),
    ...meeting.tags.slice(0, 4).map((tag) => ({ key: `tag-${tag}`, label: `#${tag}` })),
  ]

  return (
    <article data-search-meeting={meeting.id} className="grid gap-1 rounded-lg bg-surface py-3 ring-1 ring-line">
      <header className="grid gap-1 px-4">
        <h3 className="text-md font-semibold text-fg">
          <Link
            href={`/${locale}?${new URLSearchParams({ meeting: meeting.id }).toString()}`}
            className="hover:text-brand-text focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent"
          >
            <bdi dir={titleDir}>{meeting.title || t.searchUntitled}</bdi>
          </Link>
        </h3>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-3">
          <time dateTime={meeting.startedAt}>{formatMeetingDate(meeting.startedAt, locale)}</time>
          {meta.map((item) => (
            <span key={item.key} className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-fg-2">
              <bdi>{item.label}</bdi>
            </span>
          ))}
        </div>
      </header>
      {group.hits.length ? (
        <ul className="grid px-1">
          {group.hits.map((hit) => (
            <HitRow key={hit.chunkId} hit={hit} group={group} locale={locale} dictionary={t} />
          ))}
        </ul>
      ) : null}
    </article>
  )
}
