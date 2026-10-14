/**
 * Request validation and shared checks for the action-item and Tasks routes
 * (docs/parity/m5.md B7; owner: Package B). Server-only.
 */
import { z } from "zod"

import type { AuthContext } from "@/lib/auth/authz"
import { enqueueNotification } from "@/lib/notifications/enqueue"
import type {
  ActionItem,
  ActionItemPatch,
  MeetingRecord,
} from "@/lib/meetings/repository"
import { isWorkspaceVisibleMeeting, memberCanViewMeeting } from "@/lib/meetings/visibility"
import { isDateOnly } from "@/lib/tasks/patch"
import type { TaskListQuery, TaskMember } from "@/lib/tasks/types"
import { getWorkspaceStore } from "@/lib/workspaces/store"
import { getLogger } from "@/lib/log"

const log = getLogger({ component: "tasks" })

const PRIORITIES = ["low", "normal", "high", "urgent"] as const
const id = z.string().trim().min(1).max(200)
const dateOnly = z.string().refine(isDateOnly, "Expected YYYY-MM-DD")
const shortText = z.string().max(200)

export const actionItemPatchSchema = z.object({
  meetingId: id,
  title: z.string().trim().min(1).max(500).optional(),
  status: z.enum(["open", "done"]).optional(),
  priority: z.enum(PRIORITIES).optional(),
  /** Legacy free-text owner (pre-M5 clients). */
  owner: shortText.optional(),
  /** Legacy ISO due date (pre-M5 clients). */
  dueDate: z.string().max(40).optional(),
  ownerText: shortText.nullable().optional(),
  ownerParticipantId: id.nullable().optional(),
  ownerUserId: id.nullable().optional(),
  dueOn: dateOnly.nullable().optional(),
  dueText: shortText.nullable().optional(),
})

export const createActionItemSchema = z.object({
  title: z.string().trim().min(1).max(500),
  ownerText: shortText.optional(),
  ownerParticipantId: id.optional(),
  ownerUserId: id.optional(),
  dueOn: dateOnly.optional(),
  dueText: shortText.optional(),
  priority: z.enum(PRIORITIES).optional(),
  sourceSegmentId: id.optional(),
  sourceStartMs: z.number().int().min(0).optional(),
})

export const bulkTaskSchema = z.object({
  ids: z.array(id).min(1).max(100),
  patch: z
    .object({
      status: z.enum(["open", "done"]).optional(),
      ownerUserId: id.nullable().optional(),
      dueOn: dateOnly.nullable().optional(),
      priority: z.enum(PRIORITIES).optional(),
    })
    .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
      message: "patch must change at least one field",
    }),
})

export const taskQuerySchema = z.object({
  scope: z.enum(["mine", "all"]).default("all"),
  status: z.enum(["open", "done", "overdue", "all"]).default("open"),
  roomId: id.optional(),
  meetingId: id.optional(),
  ownerUserId: id.optional(),
  dueFrom: dateOnly.optional(),
  dueTo: dateOnly.optional(),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(["due", "created"]).optional(),
  cursor: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

export function parseTaskQuery(params: URLSearchParams) {
  const raw = Object.fromEntries(
    [...params.entries()].filter(([, value]) => value.trim() !== "")
  )

  return taskQuerySchema.safeParse(raw) as
    | { success: true; data: TaskListQuery }
    | { success: false; error: z.ZodError }
}

/** First validation message, for a 400 body. */
export function validationMessage(error: z.ZodError): string {
  const issue = error.issues[0]

  return issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid request"
}

/** Members of the caller's workspace an item can be assigned to. */
export async function listTaskMembers(workspaceId: string): Promise<TaskMember[]> {
  const members = await getWorkspaceStore().listMembers(workspaceId)

  return members.map((member) => ({
    userId: member.userId,
    email: member.user.email,
    name: member.user.name,
  }))
}

export type OwnerCheck =
  | { ok: true; member?: TaskMember }
  | { ok: false; error: string }

/**
 * `ownerUserId` must be a workspace member and `ownerParticipantId` a
 * participant of this meeting.
 */
export async function checkOwnerIds(
  ctx: Pick<AuthContext, "workspace" | "meetings">,
  meeting: Pick<MeetingRecord, "id">,
  patch: { ownerUserId?: string | null; ownerParticipantId?: string | null }
): Promise<OwnerCheck> {
  let member: TaskMember | undefined

  if (patch.ownerUserId) {
    member = (await listTaskMembers(ctx.workspace.id)).find(
      (candidate) => candidate.userId === patch.ownerUserId
    )
    if (!member) return { ok: false, error: "ownerUserId is not a workspace member" }
  }

  if (patch.ownerParticipantId) {
    const participants = await ctx.meetings.listMeetingParticipants(meeting.id)

    if (!participants.some((participant) => participant.id === patch.ownerParticipantId)) {
      return { ok: false, error: "ownerParticipantId is not a participant of this meeting" }
    }
  }

  return { ok: true, member }
}

/** Repository patch from a validated request body (drops `meetingId`). */
export function toRepositoryPatch(
  body: z.infer<typeof actionItemPatchSchema>,
  member?: TaskMember
): ActionItemPatch {
  const { meetingId, ...rest } = body
  const patch = Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== undefined)
  ) as ActionItemPatch

  void meetingId
  // Assigning a member without a typed name shows the member's name.
  if (member && patch.ownerText === undefined && patch.owner === undefined) {
    patch.ownerText = member.name ?? member.email
  }

  return patch
}

/**
 * `task_assigned` notification (Package C's queue) when an item is assigned
 * to someone other than the caller. Never fails the request.
 */
export async function notifyAssignment(
  ctx: Pick<AuthContext, "workspace" | "user" | "principal">,
  item: ActionItem,
  meeting: Pick<MeetingRecord, "id" | "workspaceId" | "ownerUserId" | "visibility" | "participantDetails">,
  previousOwnerUserId: string | undefined
) {
  const assignee = item.ownerUserId
  const meetingId = meeting.id

  if (!assignee || assignee === previousOwnerUserId) return
  if (ctx.principal === "user" && ctx.user?.id === assignee) return

  try {
    // An assignee who cannot open the (private) meeting is not notified:
    // the notification would point at a meeting they cannot see.
    if (!isWorkspaceVisibleMeeting(meeting)) {
      const member = (await listTaskMembers(ctx.workspace.id)).find((candidate) => candidate.userId === assignee)

      if (!member || !memberCanViewMeeting(meeting, member)) return
    }

    await enqueueNotification({
      workspaceId: ctx.workspace.id,
      userId: assignee,
      kind: "task_assigned",
      payload: {
        actionItemId: item.id,
        meetingId,
        title: item.title,
        dueOn: item.dueOn ?? null,
        assignedByUserId: ctx.user?.id ?? null,
      },
    })
  } catch (error) {
    log.warn({ err: error }, "[tasks] task_assigned notification failed")
  }
}
