import { CheckCircle2Icon, CircleAlertIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"

export type ProviderStatusView = {
  id: string
  label: string
  configured: boolean
  detail: string
  mode?: string
}

export function ProviderHealthPanel({
  providers,
}: {
  providers: ProviderStatusView[]
}) {
  return (
    <section className="ms-card grid gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Provider health</h3>
        <Badge variant="secondary" className="rounded-sm">
          live
        </Badge>
      </div>
      <div className="grid gap-2">
        {providers.map((provider) => {
          const Icon = provider.configured ? CheckCircle2Icon : CircleAlertIcon

          return (
            <div
              key={provider.id}
              className="flex min-h-14 items-start gap-3 rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-3"
            >
              <Icon
                aria-hidden="true"
                className={
                  provider.configured
                    ? "mt-0.5 size-4 text-emerald-600"
                    : "mt-0.5 size-4 text-amber-600"
                }
              />
              <div className="min-w-0">
                <div className="text-sm font-medium">{provider.label}</div>
                <p className="break-words text-xs leading-5 text-muted-foreground">
                  {provider.detail}
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
