/**
 * Transcript chunker: speaker turns, ~800-token cap, segment offsets for
 * click-to-seek (docs/parity/m6.md, A2; owner: Package A).
 *
 * STEP 0 STUB: returns no chunks.
 */
import type { MeetingSpeaker, TranscriptSegment } from "@/lib/meetings/repository"
import type { ChunkDraft } from "@/lib/search/types"

export type ChunkTranscriptInput = {
  segments: TranscriptSegment[]
  speakers: MeetingSpeaker[]
  meetingLanguage?: string
}

export type ChunkTranscriptOptions = {
  minTokens?: number
  maxTokens?: number
  overlapTokens?: number
}

export function chunkTranscript(
  input: ChunkTranscriptInput,
  opts?: ChunkTranscriptOptions
): ChunkDraft[] {
  void input
  void opts

  return []
}
