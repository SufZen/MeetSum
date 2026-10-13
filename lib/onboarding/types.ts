/**
 * Onboarding contracts (M9 Step 0, docs/parity/m9.md C3; owner: Package C).
 * Steps are computed live from real data; only skips, dismissal and
 * completion are stored (`onboarding_progress`, migration 030).
 */

export const ONBOARDING_STEPS = ["google", "invite", "glossary", "upload"] as const

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]

/** `unavailable`: admin-only steps (invite, glossary) for members. */
export type OnboardingStepStatus = "done" | "todo" | "skipped" | "unavailable"

export type OnboardingStep = { id: OnboardingStepId; status: OnboardingStepStatus; reason?: string }

/** `GET /api/onboarding`. */
export type OnboardingState = { steps: OnboardingStep[]; dismissed: boolean; completed: boolean }

/** `POST /api/onboarding`. */
export type OnboardingAction =
  | { action: "skip" | "unskip"; step: OnboardingStepId }
  | { action: "dismiss" | "complete" }

export type OnboardingProgressRow = {
  workspaceId: string
  userId: string
  skipped: OnboardingStepId[]
  dismissedAt: string | null
  completedAt: string | null
  updatedAt: string
}

/** Fresh-workspace window for the redirect. */
export const ONBOARDING_FRESH_WORKSPACE_DAYS = 14
