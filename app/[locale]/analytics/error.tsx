"use client"

/**
 * Analytics error state: a localized message, retry, and the digest in mono
 * LTR. Never renders `error.message` (docs/parity/m9.md, security check 6).
 */
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"

export default function AnalyticsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useI18n()

  return (
    <main className="grid min-h-svh place-items-center bg-canvas px-4">
      <section role="alert" className="ms-card grid max-w-md justify-items-center gap-3 p-6 text-center">
        <h1 className="text-base font-semibold text-fg">{t("analyticsLoadFailed")}</h1>
        {error.digest ? (
          <code dir="ltr" className="font-mono text-xs text-fg-3">
            {error.digest}
          </code>
        ) : null}
        <Button onClick={reset}>{t("analyticsRetry")}</Button>
      </section>
    </main>
  )
}
