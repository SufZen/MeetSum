"use client"

import { useOptionalI18n } from "@/components/i18n-provider"
import { Skeleton } from "@/components/ui/skeleton"
import { m9ShareMessages } from "@/lib/i18n/m9/share"

/** Share page skeleton (M9 B7); the status text is localized for screen readers. */
export default function ShareLoading() {
  const label = useOptionalI18n()?.t("sharePageLoading") ?? m9ShareMessages.he.sharePageLoading

  return (
    <main className="min-h-screen bg-canvas px-4 py-8 text-fg sm:px-5" aria-busy="true">
      <p role="status" className="sr-only">
        {label}
      </p>
      <div className="mx-auto grid max-w-4xl gap-4 rounded-xl border border-line bg-surface p-6 shadow-1 sm:p-8">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="mt-6 h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </main>
  )
}
