/**
 * Onboarding facts, state and redirect (docs/parity/m9.md C3). Facts are read
 * live: Google (workspace DWD subject, or the user's OAuth identity with the
 * calendar and drive scopes), members and pending invitations, workspace
 * glossary terms, and whether the caller can see any meeting. Every
 * dependency is injectable for tests. Server-only.
 */
import type { AuthContext } from "@/lib/auth/authz"
import { getOnboardingProgressStore, type OnboardingProgressStore } from "@/lib/onboarding/progress"
import { computeOnboardingState, isOnboardingAdmin, type OnboardingFacts } from "@/lib/onboarding/steps"
import { ONBOARDING_FRESH_WORKSPACE_DAYS, type OnboardingState } from "@/lib/onboarding/types"

export type OnboardingContext = Pick<AuthContext, "workspace" | "role" | "user" | "principal" | "meetings">

export type OnboardingDeps = {
  progress?: OnboardingProgressStore
  googleConnected?: (ctx: OnboardingContext) => Promise<boolean>
  countMembers?: (workspaceId: string) => Promise<{ members: number; pendingInvitations: number }>
  countGlossaryTerms?: (workspaceId: string) => Promise<number>
  workspaceCreatedAt?: (workspaceId: string) => Promise<string | undefined>
  env?: NodeJS.ProcessEnv
  now?: Date
}

async function defaultGoogleConnected(ctx: OnboardingContext): Promise<boolean> {
  if (ctx.workspace.googleSubject) return true
  if (!ctx.user?.email) return false

  const [{ getGoogleWorkspaceOAuthConnectionStatus }, { GOOGLE_WORKSPACE_SCOPES }] = await Promise.all([
    import("@/lib/google/oauth-tokens"),
    import("@/lib/google/workspace"),
  ])
  const status = await getGoogleWorkspaceOAuthConnectionStatus(ctx.user.email)
  const granted = new Set((status.scopes ?? "").split(/\s+/).filter(Boolean))
  const required = [GOOGLE_WORKSPACE_SCOPES.calendar[0], GOOGLE_WORKSPACE_SCOPES.drive[0]]

  return status.connected && required.every((scope) => !scope || granted.has(scope))
}

async function defaultCountMembers(workspaceId: string): Promise<{ members: number; pendingInvitations: number }> {
  const { getWorkspaceStore } = await import("@/lib/workspaces/store")
  const store = getWorkspaceStore()
  const [members, invitations] = await Promise.all([store.listMembers(workspaceId), store.listInvitations(workspaceId)])

  return {
    members: members.length,
    pendingInvitations: invitations.filter((invitation) => invitation.status === "pending").length,
  }
}

async function defaultCountGlossaryTerms(workspaceId: string): Promise<number> {
  const { getWorkspaceAsrGlossary } = await import("@/lib/settings/asr-glossary")

  return (await getWorkspaceAsrGlossary(workspaceId)).terms.length
}

async function defaultWorkspaceCreatedAt(workspaceId: string): Promise<string | undefined> {
  if (process.env.MEETSUM_STORAGE !== "postgres") return undefined

  const { getDatabasePool } = await import("@/lib/db/client")
  const result = await getDatabasePool().query(`select created_at from workspaces where id = $1`, [workspaceId])
  const value = (result.rows[0] as { created_at?: Date | string } | undefined)?.created_at

  return value instanceof Date ? value.toISOString() : value ?? undefined
}

/** Any error reading one fact counts it as not done (never blocks the page). */
async function safe<T>(task: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await task()
  } catch {
    return fallback
  }
}

export async function loadOnboardingFacts(ctx: OnboardingContext, deps: OnboardingDeps = {}): Promise<OnboardingFacts> {
  const admin = isOnboardingAdmin(ctx.role)
  const [googleConnected, counts, glossaryTerms, meetings] = await Promise.all([
    safe(() => (deps.googleConnected ?? defaultGoogleConnected)(ctx), false),
    admin
      ? safe(() => (deps.countMembers ?? defaultCountMembers)(ctx.workspace.id), { members: 0, pendingInvitations: 0 })
      : Promise.resolve({ members: 0, pendingInvitations: 0 }),
    admin ? safe(() => (deps.countGlossaryTerms ?? defaultCountGlossaryTerms)(ctx.workspace.id), 0) : Promise.resolve(0),
    safe(() => ctx.meetings.listMeetings({ limit: 1 }), []),
  ])

  return {
    googleConnected,
    memberCount: counts.members,
    pendingInvitations: counts.pendingInvitations,
    glossaryTerms,
    hasMeetings: meetings.length > 0,
  }
}

export async function getOnboardingState(ctx: OnboardingContext, deps: OnboardingDeps = {}): Promise<OnboardingState> {
  const userId = ctx.user?.id ?? ""
  const progressStore = deps.progress ?? (await getOnboardingProgressStore())
  const [facts, progress] = await Promise.all([
    loadOnboardingFacts(ctx, deps),
    safe(() => progressStore.get(ctx.workspace.id, userId), null),
  ])

  return computeOnboardingState(facts, ctx.role, progress)
}

export function isOnboardingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MEETSUM_ONBOARDING_ENABLED?.trim().toLowerCase() !== "false"
}

/**
 * True for an owner/admin of a workspace at most 14 days old with no
 * meetings, whose progress is neither dismissed nor completed, unless
 * `MEETSUM_ONBOARDING_ENABLED=false`. Never throws.
 */
export async function computeOnboardingRedirect(ctx: OnboardingContext, deps: OnboardingDeps = {}): Promise<boolean> {
  try {
    if (!isOnboardingEnabled(deps.env) || ctx.principal !== "user" || !ctx.user) return false
    if (!isOnboardingAdmin(ctx.role)) return false

    const createdAt = await (deps.workspaceCreatedAt ?? defaultWorkspaceCreatedAt)(ctx.workspace.id)
    const now = (deps.now ?? new Date()).getTime()

    if (createdAt && now - Date.parse(createdAt) > ONBOARDING_FRESH_WORKSPACE_DAYS * 86_400_000) return false

    const progressStore = deps.progress ?? (await getOnboardingProgressStore())
    const progress = await progressStore.get(ctx.workspace.id, ctx.user.id)

    if (progress?.dismissedAt || progress?.completedAt) return false

    const meetings = await ctx.meetings.listMeetings({ limit: 1 })

    return meetings.length === 0
  } catch {
    return false
  }
}
