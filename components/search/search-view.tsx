"use client"

/**
 * Global Search & Ask page body (docs/parity/m6.md, D1/D2). State lives in
 * the URL (`lib/client/search-url.ts`), so reloads and shared links restore
 * the query, filters and tab.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Loader2Icon, SearchIcon } from "lucide-react"

import { LazyAskPanel } from "@/components/ask/lazy"
import { CommandPaletteHost } from "@/components/command-palette"
import { SearchModeBadge } from "@/components/search/mode-badge"
import { MeetingResultCard } from "@/components/search/search-results"
import { SearchFilters } from "@/components/search/search-filters"
import { useFacets } from "@/components/search/use-facets"
import { useSearch } from "@/components/search/use-search"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { AskScope } from "@/lib/ask/types"
import { SEARCH_QUERY_MAX, parseSearchUrl, serializeSearchUrl, type SearchUrlState } from "@/lib/client/search-url"
import { formatMessage, type Dictionary } from "@/lib/i18n/dictionaries"

const DEBOUNCE_MS = 250

export function SearchView({
  locale,
  dictionary: t,
  rooms,
}: {
  locale: string
  dictionary: Dictionary
  rooms: { id: string; name: string }[]
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const query = searchParams.toString()
  const state = useMemo(() => parseSearchUrl(query), [query])
  const stateRef = useRef(state)
  const [input, setInput] = useState(state.q)
  const [syncedQ, setSyncedQ] = useState(state.q)
  const [askOpened, setAskOpened] = useState(state.tab === "ask")
  const [askRoomId, setAskRoomId] = useState("")
  const facets = useFacets(rooms)
  const { results, loadMore, retry } = useSearch(state)

  useEffect(() => {
    stateRef.current = state
  })

  // Back/forward or a palette link changed `q`: follow it in the box.
  if (syncedQ !== state.q) {
    setSyncedQ(state.q)
    if (input.trim() !== state.q) setInput(state.q)
  }

  const navigate = useCallback(
    (next: SearchUrlState) => {
      const search = serializeSearchUrl(next)

      router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false })
    },
    [pathname, router]
  )

  // Debounced search-as-you-type (Enter submits at once).
  useEffect(() => {
    const q = input.trim()

    if (q === stateRef.current.q) return

    const timer = window.setTimeout(() => navigate({ ...stateRef.current, q }), DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
  }, [input, navigate])

  const askScope: AskScope = askRoomId ? { kind: "room", roomId: askRoomId } : { kind: "workspace" }
  const askRoom = facets.rooms.find((room) => room.id === askRoomId) ?? rooms.find((room) => room.id === askRoomId)
  const askScopeLabel = askRoomId
    ? askRoom
      ? formatMessage(t.askScopeRoom, { name: askRoom.name })
      : t.askScopeRoomUnnamed
    : t.askScopeWorkspace
  const response = results.response
  const pending = response?.indexCoverage?.pending ?? 0

  return (
    <div className="mx-auto grid w-full max-w-4xl gap-4 px-4 py-4">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold text-fg">{t.searchTitle}</h1>
        <p className="text-sm text-fg-3">{t.searchSubtitle}</p>
      </header>

      <Tabs
        value={state.tab}
        onValueChange={(value) => {
          const tab = value === "ask" ? "ask" : "search"

          if (tab === "ask") setAskOpened(true)
          navigate({ ...state, q: input.trim(), tab })
        }}
        className="gap-4"
      >
        <TabsList variant="line" className="w-full justify-start border-b border-line">
          <TabsTrigger value="search">{t.searchTabSearch}</TabsTrigger>
          <TabsTrigger value="ask">{t.searchTabAsk}</TabsTrigger>
        </TabsList>

        <TabsContent value="search" className="grid gap-4">
          <form
            role="search"
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              navigate({ ...state, q: input.trim() })
            }}
          >
            <div className="relative flex-1">
              <SearchIcon aria-hidden className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-fg-3" />
              <Input
                type="search"
                dir="auto"
                autoFocus
                name="q"
                maxLength={SEARCH_QUERY_MAX}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={t.searchPlaceholder}
                aria-label={t.searchLabel}
                aria-keyshortcuts="Control+K Meta+K"
                className="h-10 ps-9"
              />
            </div>
            <Button type="submit" size="lg">
              {t.searchSubmit}
            </Button>
          </form>

          <SearchFilters state={state} facets={facets} onChange={navigate} dictionary={t} />

          <SearchResultsArea
            locale={locale}
            dictionary={t}
            results={results}
            pending={pending}
            onLoadMore={loadMore}
            onRetry={retry}
          />
        </TabsContent>

        <TabsContent value="ask" keepMounted className="grid gap-3">
          {askOpened || state.tab === "ask" ? (
            <LazyAskPanel
              locale={locale}
              dictionary={t}
              scope={askScope}
              scopeLabel={askScopeLabel}
              initialQuestion={state.tab === "ask" ? state.q : ""}
              scopeControl={
                facets.rooms.length || rooms.length ? (
                  <NativeSelect
                    size="sm"
                    value={askRoomId}
                    aria-label={t.askScopeChoose}
                    onChange={(event) => setAskRoomId(event.target.value)}
                  >
                    <NativeSelectOption value="">{t.askScopeWorkspace}</NativeSelectOption>
                    {(facets.rooms.length ? facets.rooms : rooms).map((room) => (
                      <NativeSelectOption key={room.id} value={room.id}>
                        {room.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                ) : null
              }
            />
          ) : null}
        </TabsContent>
      </Tabs>

      <CommandPaletteHost locale={locale} dictionary={t} />
    </div>
  )
}

function SearchResultsArea({
  locale,
  dictionary: t,
  results,
  pending,
  onLoadMore,
  onRetry,
}: {
  locale: string
  dictionary: Dictionary
  results: ReturnType<typeof useSearch>["results"]
  pending: number
  onLoadMore: () => void
  onRetry: () => void
}) {
  const { status, groups, response } = results

  if (status === "idle") {
    return (
      <div className="grid justify-items-center gap-1 rounded-lg border border-dashed border-line px-4 py-10 text-center">
        <p className="text-lg font-semibold text-fg">{t.searchEmptyTitle}</p>
        <p className="max-w-md text-sm text-fg-3">{t.searchEmptyBody}</p>
      </div>
    )
  }

  if (status === "error") {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger-text">
        <span>
          {results.error?.kind === "rate_limited"
            ? results.error.retryAfterSec
              ? formatMessage(t.searchRateLimitedWait, { seconds: results.error.retryAfterSec })
              : t.searchRateLimited
            : results.error?.kind === "unavailable"
              ? t.searchUnavailable
              : t.searchError}
        </span>
        <Button size="sm" variant="secondary" onClick={onRetry}>
          {t.searchRetry}
        </Button>
      </div>
    )
  }

  if (status === "loading" && !groups.length) {
    return (
      <div aria-busy="true" className="grid gap-3">
        <span className="sr-only" role="status">
          {t.searchLoading}
        </span>
        {[0, 1, 2].map((key) => (
          <div key={key} className="grid gap-2 rounded-lg bg-surface p-4 ring-1 ring-line">
            <div className="h-5 w-1/2 animate-pulse rounded-sm bg-surface-3" />
            <div className="h-3 w-1/4 animate-pulse rounded-sm bg-surface-2" />
            <div className="h-10 animate-pulse rounded-sm bg-surface-2" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <section aria-busy={status === "loading"} aria-label={t.searchTabSearch} className="grid gap-3">
      {response && (response.mode === "lexical" || pending > 0) ? (
        <div className="flex flex-wrap items-center gap-2">
          <SearchModeBadge response={response} dictionary={t} />
          {pending > 0 ? (
            <p role="status" className="text-xs text-fg-3">
              {formatMessage(t.searchIndexing, { count: pending })}
            </p>
          ) : null}
        </div>
      ) : null}

      {!groups.length ? (
        <div role="status" className="grid justify-items-center gap-1 rounded-lg border border-dashed border-line px-4 py-10 text-center">
          <p className="text-lg font-semibold text-fg">{t.searchNoResultsTitle}</p>
          <p className="text-sm text-fg-3">{t.searchNoResultsBody}</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {groups.map((group) => (
            <MeetingResultCard key={group.meeting.id} group={group} locale={locale} dictionary={t} />
          ))}
        </div>
      )}

      {results.nextCursor ? (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={onLoadMore} disabled={results.loadingMore}>
            {results.loadingMore ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : null}
            {results.loadMoreFailed ? t.searchRetry : t.searchLoadMore}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
