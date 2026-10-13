/**
 * Stored onboarding progress (`onboarding_progress`, migration 030): skipped
 * steps, dismissal and completion per (workspace, user). Demo storage keeps
 * rows in memory. Server-only.
 */
import type { Queryable } from "@/lib/db/client"
import { toIso } from "@/lib/clips/db"
import { ONBOARDING_STEPS, type OnboardingAction, type OnboardingProgressRow, type OnboardingStepId } from "@/lib/onboarding/types"

export type OnboardingProgressStore = {
  get(workspaceId: string, userId: string): Promise<OnboardingProgressRow | null>
  apply(workspaceId: string, userId: string, action: OnboardingAction): Promise<OnboardingProgressRow>
}

function isStep(value: string): value is OnboardingStepId {
  return (ONBOARDING_STEPS as readonly string[]).includes(value)
}

function mapRow(row: Record<string, unknown>): OnboardingProgressRow {
  const skipped = Array.isArray(row.skipped) ? (row.skipped as unknown[]).map(String).filter(isStep) : []

  return {
    workspaceId: String(row.workspace_id),
    userId: String(row.user_id),
    skipped,
    dismissedAt: toIso(row.dismissed_at) ?? null,
    completedAt: toIso(row.completed_at) ?? null,
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
  }
}

export function createPostgresOnboardingProgressStore(db: Queryable): OnboardingProgressStore {
  const columns = "workspace_id, user_id, skipped, dismissed_at, completed_at, updated_at"

  return {
    async get(workspaceId, userId) {
      const result = await db.query(
        `select ${columns} from onboarding_progress where workspace_id = $1 and user_id = $2`,
        [workspaceId, userId]
      )
      const row = result.rows[0] as Record<string, unknown> | undefined

      return row ? mapRow(row) : null
    },

    async apply(workspaceId, userId, action) {
      const step = "step" in action ? action.step : null
      // One upsert per action; skips are a set (no duplicates).
      const update = {
        skip: `skipped = (select array(select distinct unnest(onboarding_progress.skipped || array[$3::text])))`,
        unskip: `skipped = array_remove(onboarding_progress.skipped, $3::text)`,
        dismiss: `dismissed_at = coalesce(onboarding_progress.dismissed_at, now())`,
        complete: `completed_at = coalesce(onboarding_progress.completed_at, now())`,
      }[action.action]
      const insertSkipped = action.action === "skip" ? "array[$3::text]" : "'{}'::text[]"
      const insertDismissed = action.action === "dismiss" ? "now()" : "null"
      const insertCompleted = action.action === "complete" ? "now()" : "null"
      const values: unknown[] = [workspaceId, userId]

      if (step) values.push(step)

      const result = await db.query(
        `insert into onboarding_progress (workspace_id, user_id, skipped, dismissed_at, completed_at)
         values ($1, $2, ${insertSkipped}, ${insertDismissed}, ${insertCompleted})
         on conflict (workspace_id, user_id) do update set ${update}, updated_at = now()
         returning ${columns}`,
        values
      )

      return mapRow(result.rows[0] as Record<string, unknown>)
    },
  }
}

export function createMemoryOnboardingProgressStore(): OnboardingProgressStore {
  const rows = new Map<string, OnboardingProgressRow>()
  const key = (workspaceId: string, userId: string) => `${workspaceId}\u0000${userId}`

  return {
    async get(workspaceId, userId) {
      const row = rows.get(key(workspaceId, userId))

      return row ? { ...row, skipped: [...row.skipped] } : null
    },

    async apply(workspaceId, userId, action) {
      const now = new Date().toISOString()
      const current = rows.get(key(workspaceId, userId)) ?? {
        workspaceId,
        userId,
        skipped: [],
        dismissedAt: null,
        completedAt: null,
        updatedAt: now,
      }
      const next: OnboardingProgressRow = { ...current, skipped: [...current.skipped], updatedAt: now }

      if (action.action === "skip" && !next.skipped.includes(action.step)) next.skipped.push(action.step)
      if (action.action === "unskip") next.skipped = next.skipped.filter((step) => step !== action.step)
      if (action.action === "dismiss") next.dismissedAt ??= now
      if (action.action === "complete") next.completedAt ??= now

      rows.set(key(workspaceId, userId), next)

      return { ...next, skipped: [...next.skipped] }
    },
  }
}

let override: OnboardingProgressStore | undefined
let memory: OnboardingProgressStore | undefined

export async function getOnboardingProgressStore(): Promise<OnboardingProgressStore> {
  if (override) return override

  if (process.env.MEETSUM_STORAGE === "postgres") {
    const { getDatabasePool } = await import("@/lib/db/client")

    return createPostgresOnboardingProgressStore(getDatabasePool())
  }

  memory ??= createMemoryOnboardingProgressStore()
  return memory
}

/** Tests: force a store (undefined restores env-based selection). */
export function setOnboardingProgressStoreForTesting(store: OnboardingProgressStore | undefined) {
  override = store
  if (!store) memory = undefined
}

export function parseOnboardingAction(body: unknown): OnboardingAction | undefined {
  if (typeof body !== "object" || body === null) return undefined

  const { action, step } = body as { action?: unknown; step?: unknown }

  if (action === "dismiss" || action === "complete") return { action }
  if ((action === "skip" || action === "unskip") && typeof step === "string" && isStep(step)) return { action, step }

  return undefined
}
