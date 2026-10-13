/**
 * Compatibility entry point: the M3 `TranscriptTimeline` became the
 * virtualized, player-synced `TranscriptView` in M4.
 */
export {
  TranscriptView,
  TranscriptView as TranscriptTimeline,
} from "@/components/transcript/transcript-view"
