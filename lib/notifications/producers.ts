/**
 * M9 notification producers (docs/parity/m9.md C1), behind the Step 0
 * `notify.ts` contract. Recipients are resolved here; `enqueueNotification`
 * adds the actor skip, mutes, dedupe and the unread cap.
 *   meeting_processed: the owner plus members who are participants by email
 *     and pass the visibility rules [mp:<meetingId>:<transcriptVersion>]
 *   meeting_failed:    the owner only [mf:<meetingId>:<jobId>]
 *   invited:           an existing user with the invitation email; the row's
 *     workspace is the inviting workspace [inv:<invitationId>]
 *   bot_blocked:       the session requester, if they can see the meeting [bb:<sessionId>]
 * Every dependency is injectable for tests. Never throws. Server-only.
 */
import type { CollabBackend } from "@/lib/clips/db"
import type { MeetingRecord } from "@/lib/meetings/repository"
import { canViewMeeting } from "@/lib/meetings/visibility"
import { enqueueNotification } from "@/lib/notifications/enqueue"

export type ProducerMember = { userId: string; email: string }

export type ProducerMeeting = Pick<MeetingRecord, "id" | "workspaceId" | "ownerUserId" | "visibility"> & {
  participantEmails: string[]
}

export type ProducerInvitation = {
  id: string
  workspaceId: string
  email: string
  role: string
  status: string
}

export type ProducerDeps = {
  backend?: CollabBackend
  getMeeting?: (workspaceId: string, meetingId: string) => Promise<ProducerMeeting | undefined>
  listMembers?: (workspaceId: string) => Promise<ProducerMember[]>
  findInvitation?: (invitationId: string) => Promise<ProducerInvitation | undefined>
  getUserIdByEmail?: (email: string) => Promise<string | undefined>
  getBotRequester?: (workspaceId: string, sessionId: string) => Promise<string | undefined>
}

async function defaultGetMeeting(workspaceId: string, meetingId: string): Promise<ProducerMeeting | undefined> {
  const { getSystemMeetingRepository } = await import("@/lib/meetings/store")
  const repository = getSystemMeetingRepository(workspaceId)
  const meeting = await repository.getMeeting(meetingId, { includeTranscript: false })

  if (!meeting) return undefined

  const participants = meeting.participantDetails ?? (await repository.listMeetingParticipants(meetingId))

  return {
    id: meeting.id,
    workspaceId: meeting.workspaceId ?? workspaceId,
    ownerUserId: meeting.ownerUserId,
    visibility: meeting.visibility,
    participantEmails: participants.map((participant) => participant.email ?? "").filter(Boolean),
  }
}

async function defaultListMembers(workspaceId: string): Promise<ProducerMember[]> {
  const { getWorkspaceStore } = await import("@/lib/workspaces/store")
  const members = await getWorkspaceStore().listMembers(workspaceId)

  return members.map((member) => ({ userId: member.userId, email: member.user.email }))
}

async function defaultFindInvitation(invitationId: string): Promise<ProducerInvitation | undefined> {
  // The memory workspace store has no cross-workspace lookup by id; the
  // in-app `invited` notification exists on Postgres only.
  if (process.env.MEETSUM_STORAGE !== "postgres") return undefined

  const { getDatabasePool } = await import("@/lib/db/client")
  const result = await getDatabasePool().query(
    `select i.id, i.workspace_id, i.email, i.role, i.status
     from invitations i join workspaces w on w.id = i.workspace_id and w.deleted_at is null
     where i.id = $1`,
    [invitationId]
  )
  const row = result.rows[0] as
    | { id: string; workspace_id: string; email: string; role: string; status: string }
    | undefined

  return row ? { id: row.id, workspaceId: row.workspace_id, email: row.email, role: row.role, status: row.status } : undefined
}

async function defaultGetUserIdByEmail(email: string): Promise<string | undefined> {
  const { getWorkspaceStore } = await import("@/lib/workspaces/store")
  const user = await getWorkspaceStore().getUserByEmail(email)

  return user && !user.disabledAt ? user.id : undefined
}

async function defaultGetBotRequester(workspaceId: string, sessionId: string): Promise<string | undefined> {
  const { getBotSessionStore } = await import("@/lib/bot/store")
  const session = await getBotSessionStore().get(sessionId, { workspaceId })

  return session?.requestedByUserId ?? undefined
}

function canSee(meeting: ProducerMeeting, member: ProducerMember): boolean {
  // The recipient's own member scope (no admin bypass of private meetings).
  return canViewMeeting(
    { kind: "member", workspaceId: meeting.workspaceId ?? "", userId: member.userId, email: member.email, role: "member" },
    meeting,
    meeting.participantEmails
  )
}

const normalize = (email: string) => email.trim().toLowerCase()

/** Recipients of `meeting_processed` (exported for tests). */
export function meetingProcessedRecipients(meeting: ProducerMeeting, members: readonly ProducerMember[]): string[] {
  const participants = new Set(meeting.participantEmails.map(normalize))

  return members
    .filter(
      (member) =>
        (member.userId === meeting.ownerUserId || participants.has(normalize(member.email))) && canSee(meeting, member)
    )
    .map((member) => member.userId)
}

async function quietly(task: () => Promise<void>): Promise<void> {
  try {
    await task()
  } catch (error) {
    console.warn("[notifications] producer failed", error instanceof Error ? error.name : "error")
  }
}

export async function produceMeetingProcessed(
  input: { workspaceId: string; meetingId: string; transcriptVersion: number },
  deps: ProducerDeps = {}
): Promise<void> {
  await quietly(async () => {
    const meeting = await (deps.getMeeting ?? defaultGetMeeting)(input.workspaceId, input.meetingId)

    if (!meeting || meeting.workspaceId !== input.workspaceId) return

    const members = await (deps.listMembers ?? defaultListMembers)(input.workspaceId)
    const version = Number.isFinite(input.transcriptVersion) ? input.transcriptVersion : 0

    for (const userId of meetingProcessedRecipients(meeting, members)) {
      await enqueueNotification(
        {
          workspaceId: input.workspaceId,
          userId,
          kind: "meeting_processed",
          payload: { meetingId: meeting.id, transcriptVersion: version },
          dedupeKey: `mp:${meeting.id}:${version}`,
        },
        deps.backend
      )
    }
  })
}

export async function produceMeetingFailed(
  input: { workspaceId: string; meetingId: string; jobId: string },
  deps: ProducerDeps = {}
): Promise<void> {
  await quietly(async () => {
    const meeting = await (deps.getMeeting ?? defaultGetMeeting)(input.workspaceId, input.meetingId)

    if (!meeting || meeting.workspaceId !== input.workspaceId || !meeting.ownerUserId) return

    await enqueueNotification(
      {
        workspaceId: input.workspaceId,
        userId: meeting.ownerUserId,
        kind: "meeting_failed",
        payload: { meetingId: meeting.id, jobId: input.jobId },
        dedupeKey: `mf:${meeting.id}:${input.jobId}`,
      },
      deps.backend
    )
  })
}

export async function produceInvited(input: { invitationId: string }, deps: ProducerDeps = {}): Promise<void> {
  await quietly(async () => {
    const invitation = await (deps.findInvitation ?? defaultFindInvitation)(input.invitationId)

    if (!invitation || invitation.status !== "pending") return

    const userId = await (deps.getUserIdByEmail ?? defaultGetUserIdByEmail)(normalize(invitation.email))

    if (!userId) return

    await enqueueNotification(
      {
        workspaceId: invitation.workspaceId,
        userId,
        kind: "invited",
        payload: { invitationId: invitation.id, workspaceId: invitation.workspaceId, role: invitation.role },
        dedupeKey: `inv:${invitation.id}`,
      },
      deps.backend
    )
  })
}

export async function produceBotBlocked(
  input: { workspaceId: string; meetingId: string; sessionId: string },
  deps: ProducerDeps = {}
): Promise<void> {
  await quietly(async () => {
    const requester = await (deps.getBotRequester ?? defaultGetBotRequester)(input.workspaceId, input.sessionId)

    if (!requester) return

    const meeting = await (deps.getMeeting ?? defaultGetMeeting)(input.workspaceId, input.meetingId)
    const members = await (deps.listMembers ?? defaultListMembers)(input.workspaceId)
    const member = members.find((candidate) => candidate.userId === requester)

    if (!meeting || !member || !canSee(meeting, member)) return

    await enqueueNotification(
      {
        workspaceId: input.workspaceId,
        userId: requester,
        kind: "bot_blocked",
        payload: { meetingId: meeting.id, sessionId: input.sessionId },
        dedupeKey: `bb:${input.sessionId}`,
      },
      deps.backend
    )
  })
}
