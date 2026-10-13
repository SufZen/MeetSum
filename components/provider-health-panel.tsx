import { CheckCircle2Icon, CircleAlertIcon, TriangleAlertIcon } from "lucide-react"

import { useI18n } from "@/components/i18n-provider"
import { StatusMessageText, providerLabelString, withEnvCode } from "@/components/status-message-text"
import { Badge } from "@/components/ui/badge"
import type { StatusMessage } from "@/lib/ops/status-messages"

export type ProviderStatusView = {
  id: string
  /** English fallback; `labelId` is translated. */
  label: string
  labelId?: string
  configured: boolean
  /** English fallback; `detailMessage` is translated. */
  detail: string
  detailMessage?: StatusMessage
  mode?: string
  /** Configuration/privacy warning (e.g. GEMINI_TIER=free); never silent. */
  warning?: string
  warningMessages?: StatusMessage[]
}

/** A provider's warning, shown as a soft warn callout (translated codes, else the English text). */
export function ProviderWarning({ warning, messages }: { warning?: string; messages?: StatusMessage[] }) {
  if (!warning && !messages?.length) return null

  return (
    <div
      role="status"
      dir={messages?.length ? undefined : "ltr"}
      className="mt-1 flex items-start gap-1.5 rounded-md border border-warn/40 bg-warn-soft px-2 py-1 text-xs leading-5 text-warn-text"
    >
      <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="grid gap-0.5 break-words">
        {messages?.length
          ? messages.map((message) => (
              <span key={message.code}>
                <StatusMessageText message={message} />
              </span>
            ))
          : withEnvCode(warning ?? "")}
      </span>
    </div>
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
                  <bdi>{providerLabelString(t, provider)}</bdi>
                </div>
                <p className="break-words text-xs leading-5 text-muted-foreground">
                  <StatusMessageText message={provider.detailMessage} fallback={provider.detail} />
                </p>
                <ProviderWarning warning={provider.warning} messages={provider.warningMessages} />
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
