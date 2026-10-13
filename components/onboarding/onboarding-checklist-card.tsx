"use client"

/**
 * Onboarding checklist card for the inbox empty state (docs/parity/m9.md C3).
 * Shows the live steps and a link to the wizard until dismissed, completed,
 * or every available step is done; hidden when onboarding is disabled.
 */
import { CheckIcon, CircleIcon } from "lucide-react"
import Link from "next/link"
import { toast } from "sonner"

import { useI18n } from "@/components/i18n-provider"
import { useOnboarding } from "@/components/onboarding/use-onboarding"
import { Button, buttonVariants } from "@/components/ui/button"
import { ONBOARDING_STEP_TITLE as TITLE, statusLabelKey } from "@/lib/onboarding/steps"
import type { OnboardingState } from "@/lib/onboarding/types"

export function shouldShowChecklist(state: (OnboardingState & { enabled?: boolean }) | null): boolean {
  if (!state || state.enabled === false || state.dismissed || state.completed) return false

  return state.steps.some((step) => step.status === "todo" || step.status === "skipped")
}

export function OnboardingChecklistCard({ locale }: { locale: string }) {
  const { t } = useI18n()
  const { state, act } = useOnboarding()

  if (!state || !shouldShowChecklist(state)) return null

  const available = state.steps.filter((step) => step.status !== "unavailable")
  const done = available.filter((step) => step.status === "done").length

  const dismiss = async () => {
    if (!(await act({ action: "dismiss" }))) toast.error(t("onboardingActionFailed"))
  }

  return (
    <section aria-labelledby="onboarding-checklist-title" className="ms-card grid gap-3 p-4">
      <div className="grid gap-0.5">
        <h2 id="onboarding-checklist-title" className="text-base font-semibold text-fg">
          {t("onboardingChecklistTitle")}
        </h2>
        <p className="text-xs text-fg-3">{t("onboardingProgress", { done, total: available.length })}</p>
      </div>
      <ul className="grid gap-1.5">
        {available.map((step) => (
          <li key={step.id} className="flex items-center gap-2 text-sm">
            {step.status === "done" ? (
              <CheckIcon aria-hidden className="size-4 text-ok-text" />
            ) : (
              <CircleIcon aria-hidden className="size-4 text-fg-3" />
            )}
            <span className={step.status === "done" ? "text-fg-2 line-through" : "text-fg"}>{t(TITLE[step.id])}</span>
            <span className="sr-only">{t(statusLabelKey(step))}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Link href={`/${locale}/onboarding`} className={buttonVariants({ size: "sm" })}>
          {t("onboardingContinue")}
        </Link>
        <Button variant="ghost" size="sm" onClick={() => void dismiss()}>
          {t("onboardingDismiss")}
        </Button>
      </div>
    </section>
  )
}
