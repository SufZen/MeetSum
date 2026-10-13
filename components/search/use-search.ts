"use client"

/**
 * `GET /api/search` (B7) for the page state, with cursor pagination.
 * A new query or filter set replaces the results; "Load more" appends the
 * next page of grouped meetings.
 */
import { useCallback, useEffect, useRef, useState } from "react"

import { buildSearchApiParams, isSearchable, searchKey, type SearchUrlState } from "@/lib/client/search-url"
import type { SearchMeetingGroup, SearchResponse } from "@/lib/search/types"

export type SearchStatus = "idle" | "loading" | "ready" | "error"

export type SearchResultsState = {
  status: SearchStatus
  groups: SearchMeetingGroup[]
  response?: SearchResponse
  nextCursor: string | null
  loadingMore: boolean
  loadMoreFailed: boolean
}

const IDLE: SearchResultsState = { status: "idle", groups: [], nextCursor: null, loadingMore: false, loadMoreFailed: false }

export const SEARCH_PAGE_SIZE = 10
export const SEARCH_HITS_PER_MEETING = 3

export async function fetchSearch(
  state: SearchUrlState,
  options: { cursor?: string | null; limit?: number; hits?: number; signal?: AbortSignal }
): Promise<SearchResponse> {
  const params = buildSearchApiParams(state, {
    group: "meeting",
    limit: options.limit ?? SEARCH_PAGE_SIZE,
    hits: options.hits ?? SEARCH_HITS_PER_MEETING,
    cursor: options.cursor,
  })
  const response = await fetch(`/api/search?${params}`, { signal: options.signal })

  if (!response.ok) throw new Error(`search ${response.status}`)

  return (await response.json()) as SearchResponse
}

/** Groups from the next page that aren't already shown (cursor overlap). */
export function appendGroups(current: SearchMeetingGroup[], next: SearchMeetingGroup[] = []): SearchMeetingGroup[] {
  const seen = new Set(current.map((group) => group.meeting.id))

  return [...current, ...next.filter((group) => !seen.has(group.meeting.id))]
}

export function useSearch(state: SearchUrlState) {
  const [results, setResults] = useState<SearchResultsState>(IDLE)
  const [retryKey, setRetryKey] = useState(0)
  const key = searchKey(state)
  const stateRef = useRef(state)
  const more = useRef<AbortController | null>(null)

  useEffect(() => {
    stateRef.current = state
  })

  useEffect(() => {
    more.current?.abort()

    const current = stateRef.current

    if (!isSearchable(current)) {
      setResults(IDLE)
      return
    }

    const controller = new AbortController()

    setResults((previous) => ({ ...previous, status: "loading", loadMoreFailed: false }))
    fetchSearch(current, { signal: controller.signal })
      .then((response) => {
        setResults({
          status: "ready",
          response,
          groups: response.groups ?? [],
          nextCursor: response.nextCursor ?? null,
          loadingMore: false,
          loadMoreFailed: false,
        })
      })
      .catch(() => {
        if (!controller.signal.aborted) setResults({ ...IDLE, status: "error" })
      })

    return () => controller.abort()
  }, [key, retryKey])

  const loadMore = useCallback(() => {
    if (!results.nextCursor || results.loadingMore) return

    const controller = new AbortController()

    more.current = controller
    setResults((previous) => ({ ...previous, loadingMore: true, loadMoreFailed: false }))
    fetchSearch(stateRef.current, { cursor: results.nextCursor, signal: controller.signal })
      .then((response) => {
        setResults((previous) => ({
          ...previous,
          groups: appendGroups(previous.groups, response.groups),
          nextCursor: response.nextCursor ?? null,
          loadingMore: false,
        }))
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setResults((previous) => ({ ...previous, loadingMore: false, loadMoreFailed: true }))
        }
      })
  }, [results.loadingMore, results.nextCursor])

  const retry = useCallback(() => setRetryKey((value) => value + 1), [])

  return { results, loadMore, retry }
}
