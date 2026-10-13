/**
 * Shell navigation policy (docs/parity/m9.md D1; owner: Package D). Pure,
 * client- and server-safe; `hooks/use-shell-url.ts` applies it.
 *
 * - Panel, meeting, settings section and admin tab changes add a history
 *   entry (Back walks them); `tab` and `t` changes replace the current one.
 * - A sidebar link handles plain left clicks in-app; modifier and middle
 *   clicks keep the browser default (open in a new tab or window).
 */
import type { ShellState } from "@/lib/client/shell-url"

export type HistoryMode = "push" | "replace" | "none"

export function shellHistoryMode(current: ShellState, next: ShellState): HistoryMode {
  if (
    current.panel !== next.panel ||
    current.meeting !== next.meeting ||
    current.section !== next.section ||
    current.adminTab !== next.adminTab
  ) {
    return "push"
  }
  if (current.tab !== next.tab || current.t !== next.t) return "replace"

  return "none"
}

export type ClickLike = {
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  defaultPrevented: boolean
}

/** True when a link click should navigate in-app instead of the browser default. */
export function isPlainLeftClick(event: ClickLike): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  )
}

/** Removes one-shot parameters (e.g. `record=1`) from a query string. */
export function withoutParams(search: string, names: readonly string[]): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)

  names.forEach((name) => params.delete(name))

  const query = params.toString()

  return query ? `?${query}` : ""
}
