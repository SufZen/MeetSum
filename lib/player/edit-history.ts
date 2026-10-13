/**
 * Session undo stack for transcript edits (M4, client-safe, pure).
 *
 * The server keeps the real revision history; this stack only remembers
 * which segment the user changed most recently in this session so Ctrl/⌘+Z
 * and the toast's Undo call `POST .../undo` with the expected revision.
 */

export type EditEntry = {
  segmentId: string
  /** Segment revision after the edit (the undo's `expectedRevision`). */
  revision: number
  /** What changed, for the toast/announcement. */
  kind: "text" | "speaker"
}

export type EditHistory = { entries: readonly EditEntry[]; limit: number }

export const DEFAULT_EDIT_HISTORY_LIMIT = 20

export function createEditHistory(limit: number = DEFAULT_EDIT_HISTORY_LIMIT): EditHistory {
  return { entries: [], limit: Math.max(1, Math.floor(limit)) }
}

/** Pushes an edit; an older entry for the same segment is superseded. */
export function pushEdit(history: EditHistory, entry: EditEntry): EditHistory {
  const kept = history.entries.filter((candidate) => candidate.segmentId !== entry.segmentId)
  const entries = [...kept, entry].slice(-history.limit)

  return { ...history, entries }
}

export function peekEdit(history: EditHistory): EditEntry | undefined {
  return history.entries.at(-1)
}

export function popEdit(history: EditHistory): { entry?: EditEntry; history: EditHistory } {
  const entry = history.entries.at(-1)

  if (!entry) return { history }

  return { entry, history: { ...history, entries: history.entries.slice(0, -1) } }
}

/**
 * After an undo the segment's revision moved on; entries for it are stale.
 * Also used when a refetch shows the segment changed elsewhere.
 */
export function forgetSegment(history: EditHistory, segmentId: string): EditHistory {
  const entries = history.entries.filter((entry) => entry.segmentId !== segmentId)

  return entries.length === history.entries.length ? history : { ...history, entries }
}
