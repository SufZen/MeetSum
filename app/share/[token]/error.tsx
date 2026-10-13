"use client"

import { TriangleAlertIcon } from "lucide-react"

import { useOptionalI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import type { m9ShareMessages } from "@/lib/i18n/m9/share"

/**
 * Share page failure (M9 B7). Localized from the layout's share messages and
 * never shows the error's message or stack: the share page is public.
 */
export default function ShareError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const i18n = useOptionalI18n()
  const t = (key: keyof (typeof m9ShareMessages)["he"]) => i18n?.t(key) ?? key

  return (
    <main className="grid min-h-screen place-items-center bg-canvas px-4 py-8 text-fg">
      <Empty className="max-w-md">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TriangleAlertIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>
            <h1>{t("sharePageError")}</h1>
          </EmptyTitle>
          <EmptyDescription>{t("sharePageNotFoundHint")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button type="button" onClick={reset}>
            {t("sharePageRetry")}
          </Button>
        </EmptyContent>
      </Empty>
    </main>
  )
}
