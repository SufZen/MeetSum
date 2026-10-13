"use client"

/**
 * Onboarding wizard (docs/parity/m9.md C3): an RTL-aware stepper (directional
 * chevrons mirror via `data-icon="directional"`), one primary action per
 * step, "skip" and "finish", focus moved to each step heading. Step status is
 * live (re-read after every action).
 */
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { useI18n } from "@/components/i18n-provider"
import {
  GlossaryStepPanel,
  GoogleStepPanel,
  InviteStepPanel,
  UploadStepPanel,
} from "@/components/onboarding/onboarding-step-panels"
import { useOnboarding, type OnboardingClientState } from "@/components/onboarding/use-onboarding"
import { Button } from "@/components/ui/button"
import { ONBOARDING_STEP_TITLE as TITLE, statusLabelKey } from "@/lib/onboarding/steps"
import type { OnboardingStepId } from "@/lib/onboarding/types"
import { cn } from "@/lib/utils"

const HINT: Record<OnboardingStepId, string> = {
  google: "onboardingStepGoogleHint",
  invite: "onboardingStepInviteHint",
  glossary: "onboardingStepGlossaryHint",
  upload: "onboardingStepUploadHint",
}

export function OnboardingWizard({
  locale,
  initial,
  glossarySuggestions,
}: {
  locale: string
  initial: OnboardingClientState
  glossarySuggestions: string[]
}) {
  const { t } = useI18n()
  const { state, refresh, act } = useOnboarding(initial)
  const steps = (state ?? initial).steps
  const firstOpen = Math.max(0, steps.findIndex((step) => step.status === "todo"))
  const [index, setIndex] = useState(firstOpen)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const mounted = useRef(false)
  const step = steps[index] ?? steps[0]!
  const done = steps.filter((item) => item.status === "done").length
  const isLast = index === steps.length - 1

  useEffect(() => {
    if (mounted.current) headingRef.current?.focus()
    mounted.current = true
  }, [index])

  const goTo = (next: number) => setIndex(Math.min(Math.max(next, 0), steps.length - 1))

  const finish = async () => {
    if (await act({ action: "complete" })) window.location.assign(`/${locale}`)
    else toast.error(t("onboardingActionFailed"))
  }

  const skip = async () => {
    if (!(await act({ action: "skip", step: step.id }))) {
      toast.error(t("onboardingActionFailed"))
      return
    }
    if (isLast) await finish()
    else goTo(index + 1)
  }

  const onChanged = () => void refresh()

  return (
    <main className="min-h-svh bg-canvas">
      <div className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-8">
        <header className="grid gap-1">
          <h1 className="text-xl font-semibold text-fg">{t("onboardingTitle")}</h1>
          <p className="text-sm text-fg-2">{t("onboardingIntro")}</p>
          <p className="text-xs text-fg-3">{t("onboardingProgress", { done, total: steps.length })}</p>
        </header>

        <nav aria-label={t("onboardingStepsLabel")}>
          <ol className="grid gap-2 sm:grid-cols-4">
            {steps.map((item, position) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => goTo(position)}
                  aria-current={position === index ? "step" : undefined}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md border px-3 py-2 text-start text-sm focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent",
                    position === index ? "border-brand bg-brand-soft text-fg" : "border-line bg-surface text-fg-2"
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "grid size-5 shrink-0 place-items-center rounded-full text-xs",
                      item.status === "done" ? "bg-ok text-on-brand" : "bg-surface-3 text-fg-2"
                    )}
                  >
                    {item.status === "done" ? <CheckIcon className="size-3" /> : position + 1}
                  </span>
                  <span className="grid min-w-0">
                    <span className="truncate font-medium">{t(TITLE[item.id])}</span>
                    <span className="truncate text-xs text-fg-3">{t(statusLabelKey(item))}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <section aria-labelledby="onboarding-step-heading" className="ms-card grid gap-4 p-5">
          <div className="grid gap-1">
            <p className="text-xs text-fg-3">{t("onboardingStepOf", { current: index + 1, total: steps.length })}</p>
            <h2 id="onboarding-step-heading" ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-fg outline-none">
              {t(TITLE[step.id])}
            </h2>
            <p className="text-sm text-fg-2">{t(HINT[step.id])}</p>
          </div>

          {step.status === "unavailable" ? (
            <p className="text-sm text-fg-3">{t("onboardingUnavailable")}</p>
          ) : step.id === "google" ? (
            <GoogleStepPanel locale={locale} done={step.status === "done"} />
          ) : step.id === "invite" ? (
            <InviteStepPanel locale={locale} onChanged={onChanged} />
          ) : step.id === "glossary" ? (
            <GlossaryStepPanel suggestions={glossarySuggestions} onChanged={onChanged} />
          ) : (
            <UploadStepPanel done={step.status === "done"} onChanged={onChanged} />
          )}

          {step.status === "skipped" ? (
            <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => void act({ action: "unskip", step: step.id })}>
              {t("onboardingUnskip")}
            </Button>
          ) : null}
        </section>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="ghost" disabled={index === 0} onClick={() => goTo(index - 1)}>
            <ChevronLeftIcon aria-hidden data-icon="directional" className="rtl:-scale-x-100" />
            {t("onboardingBack")}
          </Button>
          <div className="flex flex-wrap gap-2">
            {step.status === "todo" ? (
              <Button variant="outline" onClick={() => void skip()}>
                {t("onboardingSkip")}
              </Button>
            ) : null}
            {isLast ? (
              <Button variant="outline" onClick={() => void finish()}>
                {t("onboardingFinish")}
              </Button>
            ) : (
              <Button variant="outline" onClick={() => goTo(index + 1)}>
                {t("onboardingNext")}
                <ChevronRightIcon aria-hidden data-icon="directional" className="rtl:-scale-x-100" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}
