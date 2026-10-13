/**
 * Email recap recipients (docs/parity/m8.md A10). Owner: Package A.
 *
 * Start from meeting participants with a valid email (lowercased,
 * de-duplicated), minus the bot account and unsubscribed addresses.
 * - `members` (default): only current workspace members (exact email) who
 *   can view the meeting (`memberCanViewMeeting`).
 * - `attendees`: members as above plus non-members, but NEVER for private
 *   meetings (they fall back to `members`).
 * Capped at `MEETSUM_EMAIL_RECAP_MAX_RECIPIENTS` (≤ 50).
 */
import { memberCanViewMeeting } from "@/lib/meetings/visibility"
import type { MeetingRecord } from "@/lib/meetings/repository"

export type RecapRecipient = { email: string; isMember: boolean; userId?: string }

export type RecipientResult = {
  recipients: RecapRecipient[]
  /** Counts only (no addresses). */
  excluded: { bot: number; unsubscribed: number; notMember: number; cannotView: number; overCap: number }
}

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/

export function resolveRecapRecipients(input: {
  meeting: Pick<MeetingRecord, "workspaceId" | "ownerUserId" | "visibility" | "participantDetails">
  members: readonly { userId: string; email: string }[]
  unsubscribed: ReadonlySet<string>
  audience: "members" | "attendees"
  botEmail?: string
  max: number
}): RecipientResult {
  const excluded = { bot: 0, unsubscribed: 0, notMember: 0, cannotView: 0, overCap: 0 }
  const memberByEmail = new Map(input.members.map((member) => [member.email.trim().toLowerCase(), member]))
  const isPrivate = (input.meeting.visibility ?? "private") === "private"
  const audience = isPrivate ? "members" : input.audience
  const bot = input.botEmail?.trim().toLowerCase()
  const seen = new Set<string>()
  const recipients: RecapRecipient[] = []

  for (const participant of input.meeting.participantDetails ?? []) {
    const email = participant.email?.trim().toLowerCase()

    if (!email || !EMAIL.test(email) || seen.has(email)) continue
    seen.add(email)

    if (bot && email === bot) {
      excluded.bot += 1
      continue
    }
    if (input.unsubscribed.has(email)) {
      excluded.unsubscribed += 1
      continue
    }

    const member = memberByEmail.get(email)

    if (member) {
      if (!memberCanViewMeeting(input.meeting, { userId: member.userId, email })) {
        excluded.cannotView += 1
        continue
      }
    } else if (audience === "members") {
      excluded.notMember += 1
      continue
    }

    if (recipients.length >= input.max) {
      excluded.overCap += 1
      continue
    }
    recipients.push(member ? { email, isMember: true, userId: member.userId } : { email, isMember: false })
  }

  return { recipients, excluded }
}
