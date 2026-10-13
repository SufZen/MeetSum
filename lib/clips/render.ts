/**
 * `clip.render` job (owner: Package C): cuts the clip from the meeting's
 * selected asset to AAC m4a. Step 0 stub: a no-op.
 */

export type RenderClipJobInput = {
  workspaceId: string
  clipId: string
  meetingId?: string
}

/** Object key of a rendered clip; never the source recording's key. */
export function clipStorageKey(workspaceId: string, clipId: string): string {
  return `clips/${workspaceId}/${clipId}.m4a`
}

export async function renderClipJob(input: RenderClipJobInput): Promise<Record<string, unknown>> {
  return { clipId: input.clipId, skipped: true, reason: "not implemented (M5)" }
}
