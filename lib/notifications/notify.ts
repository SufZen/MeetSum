/**
 * M9 notification producers (Step 0 contract, docs/parity/m9.md item 6;
 * owner: Package C). Call sites follow each with `.catch(() => {})`; the
 * recipients and dedupe keys are resolved in `lib/notifications/producers.ts`:
 *   meeting_processed `mp:<meetingId>:<transcriptVersion>`,
 *   meeting_failed    `mf:<meetingId>:<jobId>`,
 *   invited           `inv:<invitationId>`,
 *   bot_blocked       `bb:<sessionId>`.
 * None of these may throw into the caller. Server-only.
 */
import {
  produceBotBlocked,
  produceShareAttempts,
  produceInvited,
  produceMeetingFailed,
  produceMeetingProcessed,
} from "@/lib/notifications/producers"

export type NotifyMeetingProcessedInput = { workspaceId: string; meetingId: string; transcriptVersion: number }

export type NotifyMeetingFailedInput = { workspaceId: string; meetingId: string; jobId: string }

export type NotifyInvitedInput = { invitationId: string }

export type NotifyBotBlockedInput = { workspaceId: string; meetingId: string; sessionId: string }

export async function notifyMeetingProcessed(input: NotifyMeetingProcessedInput): Promise<void> {
  await produceMeetingProcessed(input)
}

export async function notifyMeetingFailed(input: NotifyMeetingFailedInput): Promise<void> {
  await produceMeetingFailed(input)
}

export async function notifyInvited(input: NotifyInvitedInput): Promise<void> {
  await produceInvited(input)
}

export async function notifyBotBlocked(input: NotifyBotBlockedInput): Promise<void> {
  await produceBotBlocked(input)
}

export type NotifyShareAttemptsInput = {
  workspaceId: string
  meetingId: string
  ownerUserId?: string
  shareId: string
  failures: number
}

/** share_attempts `sa:<shareId>:<day>`: the meeting owner (no password data). */
export async function notifyShareAttempts(input: NotifyShareAttemptsInput): Promise<void> {
  await produceShareAttempts(input)
}
