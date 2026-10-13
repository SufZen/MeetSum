"use client"

/**
 * Shell state from the URL (docs/parity/m9.md D1; owner: Package D).
 * `useSearchParams()` is the single source of truth: there is no mirrored
 * state. Navigation uses the native History API, which the App Router
 * integrates with `useSearchParams` without a server round trip; Back and
 * Forward walk the entries (`shellHistoryMode` decides push vs replace).
 */
import { useCallback, useMemo } from "react"
import { useSearchParams } from "next/navigation"

import { shellHistoryMode } from "@/lib/client/shell-navigation"
import { buildShellUrl, parseShellUrl, type ShellState } from "@/lib/client/shell-url"

export type ShellNavigateOptions = { replace?: boolean }

export type ShellUrl = {
  state: ShellState
  /** Merges `next` into the current state and writes the URL. */
  navigate: (next: Partial<ShellState>, options?: ShellNavigateOptions) => void
  /** The href for a state (links, modifier-click). */
  href: (next: Partial<ShellState>) => string
  /** Current raw parameters (unknown ones included). */
  searchParams: URLSearchParams
}

export function useShellUrl(locale: string): ShellUrl {
  const raw = useSearchParams()
  const searchParams = useMemo(() => new URLSearchParams(raw?.toString() ?? ""), [raw])
  const state = useMemo(() => parseShellUrl(searchParams), [searchParams])
  const href = useCallback(
    (next: Partial<ShellState>) => buildShellUrl(locale, { ...state, ...next }, searchParams),
    [locale, searchParams, state]
  )

  const navigate = useCallback(
    (next: Partial<ShellState>, options?: ShellNavigateOptions) => {
      // Read the live URL: several navigations can run before a re-render.
      const live = new URLSearchParams(window.location.search)
      const current = parseShellUrl(live)
      const target = { ...current, ...next }
      const mode = options?.replace ? "replace" : shellHistoryMode(current, target)
      const url = buildShellUrl(locale, target, live)

      if (mode === "none" && url === `${window.location.pathname}${window.location.search}`) return
      if (mode === "push") window.history.pushState(null, "", url)
      else window.history.replaceState(null, "", url)
    },
    [locale]
  )

  return { state, navigate, href, searchParams }
}
