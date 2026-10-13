/**
 * Server-side resolution of a `?meeting=` deep link for the shell page
 * (docs/parity/m9.md D1). The loader is the request's visibility-scoped
 * repository (`ctx.meetings.getMeeting`), so a meeting the user may not see
 * comes back `undefined` and renders the inbox with a notice, never an error.
 */
import type { ShellState } from "@/lib/client/shell-url"

export type ShellDeepLink<T> =
  | { kind: "none" }
  | { kind: "listed"; meetingId: string }
  | { kind: "fetched"; meetingId: string; meeting: T }
  | { kind: "unavailable"; meetingId: string }

export async function resolveShellDeepLink<T>(
  state: Pick<ShellState, "meeting">,
  firstPage: ReadonlyArray<{ id: string }>,
  load: (meetingId: string) => Promise<T | undefined>
): Promise<ShellDeepLink<T>> {
  const meetingId = state.meeting

  if (!meetingId) return { kind: "none" }
  if (firstPage.some((meeting) => meeting.id === meetingId)) return { kind: "listed", meetingId }

  try {
    const meeting = await load(meetingId)

    return meeting ? { kind: "fetched", meetingId, meeting } : { kind: "unavailable", meetingId }
  } catch {
    return { kind: "unavailable", meetingId }
  }
}
