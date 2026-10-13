/**
 * Adaptive polling for the command center (M4, client-safe, pure).
 *
 * Jobs/list refresh every 5 s while something is processing, every 60 s when
 * idle, and not at all while the tab is hidden (a visibility change triggers
 * an immediate refresh instead).
 */

export const ACTIVE_POLL_MS = 5_000
export const IDLE_POLL_MS = 60_000
/** Providers and workspace status change rarely. */
export const SLOW_STATUS_POLL_MS = 5 * 60_000

export function nextPollDelay({
  activeJobs,
  selectedProcessing,
  hidden,
}: {
  /** Queued or active jobs in the workspace. */
  activeJobs: number
  /** The selected meeting is mid-pipeline. */
  selectedProcessing: boolean
  /** `document.visibilityState === "hidden"`. */
  hidden: boolean
}): number | null {
  if (hidden) return null

  return activeJobs > 0 || selectedProcessing ? ACTIVE_POLL_MS : IDLE_POLL_MS
}
