import { CheckCircle2Icon, CircleAlertIcon, TriangleAlertIcon } from "lucide-react"

import { useI18n } from "@/components/i18n-provider"
import { Badge } from "@/components/ui/badge"

export type ProviderStatusView = {
  id: string
  label: string
  configured: boolean
  detail: string
  mode?: string
  /** Configuration/privacy warning (e.g. GEMINI_TIER=free); never silent. */
  warning?: string
}

/** A provider's warning, shown as a soft warn callout. */
export function ProviderWarning({ warning }: { warning?: string }) {
  if (!warning) return null

  return (
    <p
      role="status"
      dir="ltr"
      className="mt-1 flex items-start gap-1.5 rounded-md border border-warn/40 bg-warn-soft px-2 py-1 text-xs leading-5 text-warn-text"
    >
      <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="break-words">{warning}</span>
    </p>
  )
}

export function ProviderHealthPanel({
  providers,
}: {
  providers: ProviderStatusView[]
}) {
  const { t } = useI18n()

  return (
    <section className="ms-card grid gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("opsProviderHealthTitle")}</h3>
        <Badge variant="secondary" className="rounded-sm">
          {t("opsProviderHealthLive")}
        </Badge>
      </div>
      <div className="grid gap-2">
        {providers.map((provider) => {
          const Icon = provider.configured ? CheckCircle2Icon : CircleAlertIcon

          return (
            <div
              key={provider.id}
              className="flex min-h-14 items-start gap-3 rounded-lg border border-line bg-surface-2 p-3"
            >
              <Icon
                aria-hidden="true"
                className={
                  provider.configured
                    ? "mt-0.5 size-4 text-ok-text"
                    : "mt-0.5 size-4 text-warn-text"
                }
              />
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  <bdi>{provider.label}</bdi>
                </div>
                <p className="break-words text-xs leading-5 text-muted-foreground">
                  {provider.detail}
                </p>
                <ProviderWarning warning={provider.warning} />
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
