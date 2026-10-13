"use client"

/**
 * Route segment states (docs/parity/m9.md D3; owner: Package D): the
 * `loading.tsx`, `error.tsx` and `not-found.tsx` bodies under `app/[locale]`.
 * - Loading skeletons keep the final layout (rail | inbox | reading column).
 * - Errors never render `error.message` in production; only the digest, in
 *   mono LTR, so support can find the server log.
 * - Not found is the Σ empty state with one next action.
 */
import Link from "next/link"

import { useOptionalI18n } from "@/components/i18n-provider"
import { Button, buttonVariants } from "@/components/ui/button"
import { SigmaMark } from "@/components/ui/sigma-mark"
import { Skeleton } from "@/components/ui/skeleton"
import type { SupportedLocale } from "@/lib/i18n/locales"

/**
 * Hebrew defaults for the few keys used here, outside a provider. Inlined so
 * every `[locale]` route does not ship both locales of the shell module
 * (`tests/segment-states.test.ts` keeps them equal to `m9ShellMessages.he`).
 */
export const SEGMENT_FALLBACK_HE = {
  shellLoading: "טוען…",
  shellErrorTitle: "משהו השתבש",
  shellErrorDigest: "מזהה שגיאה",
  shellErrorRetry: "נסו שוב",
  shellErrorBackToMeetings: "חזרה לפגישות",
  shellNotFoundTitle: "הדף לא נמצא",
  shellNotFoundDescription: "הדף אינו קיים או שהועבר.",
  shellNotFoundAction: "חזרה לפגישות",
} as const

type ShellKey = keyof typeof SEGMENT_FALLBACK_HE

/** Dictionary text, falling back to the Hebrew default outside a provider. */
function useShellText(): { t: (key: ShellKey) => string; locale: SupportedLocale } {
  const i18n = useOptionalI18n()

  return {
    t: (key) => i18n?.t(key) ?? SEGMENT_FALLBACK_HE[key],
    locale: i18n?.locale ?? "he",
  }
}

export type LoadingVariant = "shell" | "page"

/** Skeleton for a segment; `shell` mirrors rail | inbox | reading column. */
export function SegmentLoading({ variant = "page" }: { variant?: LoadingVariant }) {
  const { t } = useShellText()

  if (variant === "shell") {
    return (
      <div
        role="status"
        aria-busy="true"
        className="grid min-h-svh grid-cols-1 bg-canvas lg:grid-cols-[220px_330px_minmax(0,1fr)]"
      >
        <span className="sr-only">{t("shellLoading")}</span>
        <div className="hidden flex-col gap-2 border-e border-line p-3 lg:flex">
          <Skeleton className="h-8 w-32" />
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </div>
        <div className="hidden flex-col gap-3 border-e border-line bg-surface p-3 lg:flex">
          <Skeleton className="h-8 w-full" />
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-20 w-full" />
          ))}
        </div>
        <div className="flex flex-col gap-4 bg-surface-2 p-6">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    )
  }

  return (
    <div role="status" aria-busy="true" className="mx-auto flex min-h-svh w-full max-w-5xl flex-col gap-4 bg-canvas p-6">
      <span className="sr-only">{t("shellLoading")}</span>
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-4 w-1/3" />
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-20 w-full" />
      ))}
    </div>
  )
}

/** Whether an error page may show developer detail (never in production). */
export function mayShowErrorDetail(nodeEnv: string | undefined): boolean {
  return nodeEnv !== "production"
}

export function SegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const { t, locale } = useShellText()

  return (
    <div className="grid min-h-svh place-items-center bg-canvas p-6">
      <section role="alert" className="ms-card flex max-w-md flex-col items-center gap-4 p-8 text-center">
        <SigmaMark className="size-10" />
        <h1 className="text-xl font-semibold">{t("shellErrorTitle")}</h1>
        {error.digest ? (
          <p className="text-sm text-muted-foreground">
            {t("shellErrorDigest")}:{" "}
            <code dir="ltr" className="font-mono text-xs">
              {error.digest}
            </code>
          </p>
        ) : null}
        {mayShowErrorDetail(process.env.NODE_ENV) ? (
          <pre dir="ltr" className="max-w-full overflow-auto text-start font-mono text-xs text-muted-foreground">
            {error.message}
          </pre>
        ) : null}
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={reset}>{t("shellErrorRetry")}</Button>
          <Link href={`/${locale}`} className={buttonVariants({ variant: "outline" })}>
            {t("shellErrorBackToMeetings")}
          </Link>
        </div>
      </section>
    </div>
  )
}

export function SegmentNotFound() {
  const { t, locale } = useShellText()

  return (
    <div className="grid min-h-svh place-items-center bg-canvas p-6">
      <section className="flex max-w-md flex-col items-center gap-3 text-center">
        <SigmaMark state="lanes" className="size-12" />
        <h1 className="text-xl font-semibold">{t("shellNotFoundTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("shellNotFoundDescription")}</p>
        <Link href={`/${locale}`} className={buttonVariants()}>
          {t("shellNotFoundAction")}
        </Link>
      </section>
    </div>
  )
}
