/**
 * Meeting indexer: chunk, hash, embed changed chunks, write chunks and
 * vectors, set the meeting's search-index state (docs/parity/m6.md, A6;
 * owner: Package A).
 *
 * STEP 0 STUB: every meeting is skipped.
 */
export type IndexMeetingResult = {
  state: "ready" | "skipped" | "failed"
  mode?: "hybrid" | "lexical"
  chunks: number
  embedded: number
  reused: number
}

export async function indexMeeting(
  scope: { workspaceId: string },
  meetingId: string,
  opts: { force?: boolean; signal?: AbortSignal; jobId?: string } = {}
): Promise<IndexMeetingResult> {
  void scope
  void meetingId
  void opts

  return { state: "skipped", chunks: 0, embedded: 0, reused: 0 }
}
