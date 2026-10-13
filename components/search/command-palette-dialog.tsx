"use client"

/**
 * The Ctrl/Cmd+K palette (cmdk): search-as-you-type over meetings (top 5
 * groups), jump to a meeting, see all results, or "Ask about …". With no
 * meeting match, Enter asks MeetSum instead.
 */
import { Fragment, useEffect, useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { ArrowUpRightIcon, CalendarDaysIcon, SearchIcon } from "lucide-react"

import { useOptionalI18n } from "@/components/i18n-provider"
import { defaultPaletteSelection } from "@/components/search/palette-selection"
import { formatMeetingDate } from "@/components/search/search-results"
import { fetchSearch } from "@/components/search/use-search"
import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { CitedMark } from "@/components/ui/meeting-atoms"
import { EMPTY_SEARCH_STATE, SEARCH_QUERY_MAX, serializeSearchUrl } from "@/lib/client/search-url"
import { dirForLanguage } from "@/lib/client/highlight"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { SearchMeetingGroup } from "@/lib/search/types"

const PALETTE_LIMIT = 5
const DEBOUNCE_MS = 200

export function CommandPaletteDialog({
  open,
  onOpenChange,
  locale,
  dictionary: t,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  locale: string
  dictionary: Dictionary
}) {
  const router = useRouter()
  // A's resolved zone (user → workspace → env); the formatter's default otherwise.
  const timeZone = useOptionalI18n()?.timeZone
  const [value, setValue] = useState("")
  const [groups, setGroups] = useState<SearchMeetingGroup[]>([])
  const [searchedFor, setSearchedFor] = useState("")
  const [selected, setSelected] = useState("__open")
  const q = value.trim()

  const [wasOpen, setWasOpen] = useState(open)

  // Every open starts fresh (the palette also closes through `go`, which
  // bypasses the dialog's own close handler). Reset while rendering, not in
  // an effect (https://react.dev/learn/you-might-not-need-an-effect).
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setValue("")
      setGroups([])
      setSearchedFor("")
      setSelected("__open")
    }
  }

  useEffect(() => {
    if (!open || !q) return

    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void fetchSearch({ ...EMPTY_SEARCH_STATE, q }, { limit: PALETTE_LIMIT, hits: 1, signal: controller.signal })
        .then((response) => {
          const next = (response.groups ?? []).slice(0, PALETTE_LIMIT)

          setGroups(next)
          setSearchedFor(q)
          // The top meeting is selected once results arrive: Enter jumps to it.
          setSelected(defaultPaletteSelection(q, next))
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setGroups([])
            setSearchedFor(q)
            setSelected(defaultPaletteSelection(q, []))
          }
        })
    }, DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [open, q])

  const go = (href: string) => {
    onOpenChange(false)
    router.push(href)
  }
  const searchHref = (tab: "search" | "ask") => {
    const search = serializeSearchUrl({ ...EMPTY_SEARCH_STATE, q, tab })

    return `/${locale}/search${search ? `?${search}` : ""}`
  }
  const visibleGroups = q && searchedFor === q ? groups : []
  const askItem = q ? (
    <CommandItem key="ask" value="__ask" onSelect={() => go(searchHref("ask"))}>
      <CitedMark aria-hidden className="text-ai-text" />
      <span className="min-w-0 truncate">{withSlot(t.searchPaletteAsk, <bdi className="font-medium">{q}</bdi>)}</span>
    </CommandItem>
  ) : null
  const allItem = (
    <CommandItem key="all" value="__all" onSelect={() => go(searchHref("search"))}>
      <SearchIcon aria-hidden />
      <span className="min-w-0 truncate">{withSlot(t.searchPaletteAllResults, <bdi>{q}</bdi>)}</span>
    </CommandItem>
  )
  const noMatch = Boolean(q) && searchedFor === q && !groups.length

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) setValue("")
      }}
      title={t.searchPaletteTitle}
      description={t.searchPaletteDescription}
    >
      <Command shouldFilter={false} loop value={selected} onValueChange={setSelected}>
        <CommandInput
          aria-label={t.searchPaletteTitle}
          dir="auto"
          value={value}
          maxLength={SEARCH_QUERY_MAX}
          onValueChange={setValue}
          placeholder={t.searchPalettePlaceholder}
        />
        <CommandList>
          {!q ? <p className="px-3 pt-3 pb-1 text-sm text-fg-3">{t.searchPaletteEmpty}</p> : null}
          {noMatch ? <p className="px-3 pt-3 pb-1 text-sm text-fg-3">{t.searchPaletteNoMatch}</p> : null}
          {/* No meeting match: Ask comes first, so Enter asks. */}
          {q && !visibleGroups.length ? (
            <CommandGroup heading={t.searchPaletteActions}>
              {askItem}
              {allItem}
            </CommandGroup>
          ) : null}
          {visibleGroups.length ? (
            <CommandGroup heading={t.searchPaletteMeetings}>
              {visibleGroups.map((group) => (
                <CommandItem
                  key={group.meeting.id}
                  value={`meeting:${group.meeting.id}`}
                  onSelect={() => go(`/${locale}?${new URLSearchParams({ meeting: group.meeting.id }).toString()}`)}
                >
                  <CalendarDaysIcon aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    <bdi dir={dirForLanguage(group.meeting.language)}>{group.meeting.title || t.searchUntitled}</bdi>
                  </span>
                  <time dateTime={group.meeting.startedAt} className="shrink-0 text-xs text-fg-3">
                    {formatMeetingDate(group.meeting.startedAt, locale, timeZone)}
                  </time>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {visibleGroups.length ? (
            <CommandGroup heading={t.searchPaletteActions}>
              {allItem}
              {askItem}
            </CommandGroup>
          ) : null}
          {!q ? (
            <CommandGroup heading={t.searchPaletteActions}>
              <CommandItem value="__open" onSelect={() => go(`/${locale}/search`)}>
                <ArrowUpRightIcon aria-hidden data-directional="" className="rtl:-scale-x-100" />
                {t.searchPaletteOpenSearch}
              </CommandItem>
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}

/** Renders a message with its `{query}` placeholder replaced by a node. */
function withSlot(template: string, slot: ReactNode): ReactNode {
  const [before, ...rest] = template.split("{query}")

  return (
    <>
      {before}
      {rest.map((after, index) => (
        <Fragment key={index}>
          {slot}
          {after}
        </Fragment>
      ))}
    </>
  )
}
