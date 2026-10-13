/**
 * Player time formatting (M4, client-safe, pure).
 *
 * Clock strings are Western digits for `<time dir="ltr">`. Meeting-level
 * duration labels and spoken durations come from Package B's
 * `lib/meetings/duration.ts` (single source of truth); they are re-exported
 * here for player call sites.
 */
export {
  formatDurationLabel,
  formatSpokenDuration,
  formatTimestamp as formatClock,
  getMeetingDurationMs,
} from "@/lib/meetings/duration"
