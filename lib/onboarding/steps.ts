/**
 * Onboarding step computation (docs/parity/m9.md C3). Pure: steps are
 * derived from live facts; only skips, dismissal and completion are stored.
 *   google   — Google identity with the required scopes, or the workspace
 *              domain-wide-delegation subject configured
 *   invite   — admin+; done with 2+ members or a pending invitation
 *   glossary — admin+; done with 1+ workspace terms
 *   upload   — done with 1+ meetings
 * Client- and server-safe.
 */
import {
  ONBOARDING_STEPS,
  type OnboardingProgressRow,
  type OnboardingState,
  type OnboardingStep,
  type OnboardingStepId,
} from "@/lib/onboarding/types"
import type { WorkspaceRole } from "@/lib/workspaces/types"

export type OnboardingFacts = {
  googleConnected: boolean
  memberCount: number
  pendingInvitations: number
  glossaryTerms: number
  hasMeetings: boolean
}

export const ADMIN_ONLY_STEPS: readonly OnboardingStepId[] = ["invite", "glossary"]

export function isOnboardingAdmin(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin"
}

function isDone(id: OnboardingStepId, facts: OnboardingFacts): boolean {
  switch (id) {
    case "google":
      return facts.googleConnected
    case "invite":
      return facts.memberCount >= 2 || facts.pendingInvitations > 0
    case "glossary":
      return facts.glossaryTerms > 0
    case "upload":
      return facts.hasMeetings
  }
}

export function computeOnboardingState(
  facts: OnboardingFacts,
  role: WorkspaceRole,
  progress: Pick<OnboardingProgressRow, "skipped" | "dismissedAt" | "completedAt"> | null
): OnboardingState {
  const skipped = new Set(progress?.skipped ?? [])
  const steps: OnboardingStep[] = ONBOARDING_STEPS.map((id) => {
    if (ADMIN_ONLY_STEPS.includes(id) && !isOnboardingAdmin(role)) {
      return { id, status: "unavailable", reason: "admin_only" }
    }
    if (isDone(id, facts)) return { id, status: "done" }

    return { id, status: skipped.has(id) ? "skipped" : "todo" }
  })

  return { steps, dismissed: Boolean(progress?.dismissedAt), completed: Boolean(progress?.completedAt) }
}

/** Steps still open (neither done, skipped nor unavailable). */
export function openOnboardingSteps(state: OnboardingState): OnboardingStepId[] {
  return state.steps.filter((step) => step.status === "todo").map((step) => step.id)
}
