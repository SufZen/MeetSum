import type {
  MeetingRecord,
  MeetingVisibility,
  RepoScope,
} from "@/lib/meetings/repository"
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspaces/constants"

/**
 * Meeting visibility rules (M2, docs/parity/m2.md "Model & rules"):
 * - `workspace` / `link`: every principal of the meeting's workspace.
 * - `private`: the owner, plus members whose email matches a participant
 *   email of that meeting. Admins do NOT bypass private.
 * - API keys: workspace|link, plus private meetings owned by the key creator.
 * - System scope (worker, signed webhooks): workspace filter only.
 * A meeting of another workspace is never visible.
 */

const SHARED_VISIBILITIES: readonly MeetingVisibility[] = ["workspace", "link"]

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export type MeetingVisibilityFacts = Pick<
  MeetingRecord,
  "workspaceId" | "ownerUserId" | "visibility"
>

export function canViewMeeting(
  scope: RepoScope,
  meeting: MeetingVisibilityFacts,
  participantEmails: readonly (string | null | undefined)[] = []
): boolean {
  // Pre-M2 records without a workspace belong to the default workspace.
  const workspaceId = meeting.workspaceId ?? DEFAULT_WORKSPACE_ID

  if (workspaceId !== scope.workspaceId) return false
  if (scope.kind === "system") return true

  const visibility: MeetingVisibility = meeting.visibility ?? "workspace"

  if (SHARED_VISIBILITIES.includes(visibility)) return true

  // private
  if (scope.kind === "api_key") {
    return Boolean(
      scope.ownerUserId && meeting.ownerUserId === scope.ownerUserId
    )
  }

  if (meeting.ownerUserId && meeting.ownerUserId === scope.userId) return true

  const email = normalizeEmail(scope.email)

  return (
    email.length > 0 &&
    participantEmails.some(
      (candidate) => candidate != null && normalizeEmail(candidate) === email
    )
  )
}

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * SQL predicate restricting `alias` (a `meetings` row) to what `scope` may
 * see. Parameters are appended to `values`; placeholders are numbered from
 * the current `values.length`, so call it while building the value list.
 */
export function meetingScopeSql(
  scope: RepoScope,
  alias: string,
  values: unknown[]
): string {
  if (!SQL_IDENTIFIER.test(alias)) {
    throw new Error(`Invalid SQL alias: ${alias}`)
  }

  const param = (value: unknown) => {
    values.push(value)
    return `$${values.length}`
  }
  const workspace = `${alias}.workspace_id = ${param(scope.workspaceId)}`

  if (scope.kind === "system") return `(${workspace})`

  const shared = `${alias}.visibility in ('workspace', 'link')`

  if (scope.kind === "api_key") {
    if (!scope.ownerUserId) return `(${workspace} and ${shared})`

    return (
      `(${workspace} and (${shared} or ` +
      `(${alias}.visibility = 'private' and ${alias}.owner_user_id = ${param(scope.ownerUserId)})))`
    )
  }

  const owner = `${alias}.owner_user_id = ${param(scope.userId)}`
  const participant =
    `exists (select 1 from meeting_participants mp_scope ` +
    `where mp_scope.meeting_id = ${alias}.id ` +
    `and lower(mp_scope.email) = ${param(normalizeEmail(scope.email))})`

  return `(${workspace} and (${shared} or ${owner} or ${participant}))`
}
