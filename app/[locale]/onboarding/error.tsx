"use client"

/**
 * Onboarding error state: localized message, retry and a way back to the
 * meetings; the digest in mono LTR, never `error.message`.
 */
import Link from "next/link"

import { useI18n } from "@/components/i18n-provider"
import { Button, buttonVariants } from "@/components/ui/button"

export default function OnboardingError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t, locale } = useI18n()

  return (
    <main className="grid min-h-svh place-items-center bg-canvas px-4">
      <section role="alert" className="ms-card grid max-w-md justify-items-center gap-3 p-6 text-center">
        <h1 className="text-base font-semibold text-fg">{t("onboardingActionFailed")}</h1>
        {error.digest ? (
          <code dir="ltr" className="font-mono text-xs text-fg-3">
            {error.digest}
          </code>
        ) : null}
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={reset}>{t("analyticsRetry")}</Button>
          <Link href={`/${locale}`} className={buttonVariants({ variant: "outline" })}>
            {t("onboardingGoToMeetings")}
          </Link>
        </div>
      </section>
    </main>
  )
}
