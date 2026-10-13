/**
 * M9 notification producers (Step 0 contract, docs/parity/m9.md item 6;
 * owner: Package C). Step 0 ships no-op stubs with their call sites wired
 * (each call is followed by `.catch(() => {})`); Package C resolves the
 * recipients (owner/participants passing `canViewMeeting`, the invitee, the
 * bot session requester) and enqueues with the dedupe keys:
 *   meeting_processed `mp:<meetingId>:<transcriptVersion>`,
 *   meeting_failed    `mf:<meetingId>:<jobId>`,
 *   invited           `inv:<invitationId>`,
 *   bot_blocked       `bb:<sessionId>`.
 * None of these may throw into the caller. Server-only.
 */

export type NotifyMeetingProcessedInput = { workspaceId: string; meetingId: string; transcriptVersion: number }

export type NotifyMeetingFailedInput = { workspaceId: string; meetingId: string; jobId: string }

export type NotifyInvitedInput = { invitationId: string }

export type NotifyBotBlockedInput = { workspaceId: string; meetingId: string; sessionId: string }

export async function notifyMeetingProcessed(input: NotifyMeetingProcessedInput): Promise<void> {
  void input
}

export async function notifyMeetingFailed(input: NotifyMeetingFailedInput): Promise<void> {
  void input
}

export async function notifyInvited(input: NotifyInvitedInput): Promise<void> {
  void input
}

export async function notifyBotBlocked(input: NotifyBotBlockedInput): Promise<void> {
  void input
}
