import type { SearchMeetingGroup } from "@/lib/search/types"

/**
 * The palette item selected by default: the top meeting once results
 * arrive (Enter jumps to it), "Ask about …" without a meeting match, and
 * "Open search" for an empty query.
 */
export function defaultPaletteSelection(q: string, groups: readonly SearchMeetingGroup[]): string {
  if (!q) return "__open"

  return groups[0] ? `meeting:${groups[0].meeting.id}` : "__ask"
}
