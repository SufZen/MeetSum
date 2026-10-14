"use client"

import { useCallback, useEffect, useState } from "react"
import { ExternalLinkIcon, RotateCcwIcon } from "lucide-react"
import { toast } from "sonner"

import { BdiMessage } from "@/components/bot/bdi-message"
import { useOptionalI18n } from "@/components/i18n-provider"
import { integrationsApi, type WebhookDeliveryView, type WebhookSubscriptionView } from "@/components/integrations/api"
import { im } from "@/components/integrations/messages"
import { ExceptionPill, IntegrationsSection, When } from "@/components/integrations/pieces"
import {
  DELIVERY_STATUSES,
  DELIVERY_STATUS_KEYS,
  PROVIDER_LABEL_KEYS,
  deliveriesQuery,
  deliveryExternalUrl,
  deliveryMeetingLabel,
  deliveryPill,
  formatWhen,
  isDeliveryRetryable,
  isWebhookDeliveryRetryable,
  deliveryErrorKey,
  ruleDisplayName,
  skipReasonKey,
  type DeliveryFilters,
} from "@/components/integrations/state"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { DeliveryStatus, IntegrationDeliveryDTO, IntegrationRuleDTO } from "@/lib/integrations/core/types"

const LOG_PROVIDERS = ["slack", "notion", "hubspot", "email", "google_drive"] as const

function statusText(t: Dictionary, status: string) {
  return (DELIVERY_STATUSES as readonly string[]).includes(status) ? t[DELIVERY_STATUS_KEYS[status as DeliveryStatus]] : status
}

function StatusCell({ t, status }: { t: Dictionary; status: string }) {
  const pill = deliveryPill(status)

  return pill ? <ExceptionPill tone={pill}>{statusText(t, status)}</ExceptionPill> : <span className="text-xs text-fg-2">{statusText(t, status)}</span>
}

/**
 * Delivery log (D1): Integrations (A7) and Webhooks (existing API) tabs,
 * filters, cursor pagination, a row detail drawer and Retry. A delivery whose
 * meeting the viewer can't see shows "Private meeting", never its title.
 */
export function DeliveryLog({
  t,
  locale,
  rules,
  refreshKey,
}: {
  t: Dictionary
  locale: string
  rules: readonly IntegrationRuleDTO[]
  /** Bumped by the page after a change elsewhere (connect, rule edits…). */
  refreshKey: number
}) {
  const [tab, setTab] = useState<"integrations" | "webhooks">("integrations")

  return (
    <IntegrationsSection id="integrations-delivery-log" title={t.integrationsSectionDeliveryLog}>
      <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)} className="ms-card gap-3 p-3 lg:p-4">
        <TabsList>
          <TabsTrigger value="integrations">{t.integrationsLogTabIntegrations}</TabsTrigger>
          <TabsTrigger value="webhooks">{t.integrationsLogTabWebhooks}</TabsTrigger>
        </TabsList>
        <TabsContent value="integrations">
          <IntegrationDeliveries t={t} locale={locale} rules={rules} refreshKey={refreshKey} />
        </TabsContent>
        <TabsContent value="webhooks">
          {tab === "webhooks" ? <WebhookDeliveries t={t} locale={locale} refreshKey={refreshKey} /> : null}
        </TabsContent>
      </Tabs>
    </IntegrationsSection>
  )
}

function IntegrationDeliveries({
  t,
  locale,
  rules,
  refreshKey,
}: {
  t: Dictionary
  locale: string
  rules: readonly IntegrationRuleDTO[]
  refreshKey: number
}) {
  const timeZone = useOptionalI18n()?.timeZone
  const [filters, setFilters] = useState<DeliveryFilters>({})
  const [rows, setRows] = useState<IntegrationDeliveryDTO[]>([])
  const [cursor, setCursor] = useState<string>()
  const [state, setState] = useState<"loading" | "idle" | "error">("loading")
  const [detail, setDetail] = useState<IntegrationDeliveryDTO | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(
    async (append?: string) => {
      setState("loading")
      const result = await integrationsApi.deliveries(deliveriesQuery(filters, append))

      if (!result.ok) {
        setState("error")
        return
      }
      setRows((current) => (append ? [...current, ...result.body.deliveries] : result.body.deliveries))
      setCursor(result.body.nextCursor)
      setState("idle")
    },
    [filters]
  )

  useEffect(() => {
    let cancelled = false

    void integrationsApi.deliveries(deliveriesQuery(filters)).then((result) => {
      if (cancelled) return
      if (!result.ok) {
        setState("error")
        return
      }
      setRows(result.body.deliveries)
      setCursor(result.body.nextCursor)
      setState("idle")
    })

    return () => {
      cancelled = true
    }
  }, [filters, refreshKey])

  async function retry(delivery: IntegrationDeliveryDTO) {
    setBusy(true)
    const result = await integrationsApi.retryDelivery(delivery.id)

    setBusy(false)
    if (result.ok) toast.success(t.integrationsLogRetried)
    else toast.error(t.integrationsSaveFailed)
    setDetail(null)
    await load()
  }

  const ruleName = (id?: string) => {
    const rule = rules.find((item) => item.id === id)

    return rule ? ruleDisplayName(rule, t) : undefined
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        <label className="grid gap-1 text-xs text-fg-2">
          {t.integrationsLogFilterStatus}
          <NativeSelect size="sm" value={filters.status ?? ""} onChange={(event) => setFilters({ ...filters, status: event.target.value || undefined })}>
            <NativeSelectOption value="">—</NativeSelectOption>
            {DELIVERY_STATUSES.map((status) => (
              <NativeSelectOption key={status} value={status}>
                {t[DELIVERY_STATUS_KEYS[status]]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label className="grid gap-1 text-xs text-fg-2">
          {t.integrationsLogFilterProvider}
          <NativeSelect size="sm" value={filters.provider ?? ""} onChange={(event) => setFilters({ ...filters, provider: event.target.value || undefined })}>
            <NativeSelectOption value="">—</NativeSelectOption>
            {LOG_PROVIDERS.map((provider) => (
              <NativeSelectOption key={provider} value={provider}>
                {t[PROVIDER_LABEL_KEYS[provider]]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        {rules.length ? (
          <label className="grid gap-1 text-xs text-fg-2">
            {t.integrationsLogFilterRule}
            <NativeSelect size="sm" value={filters.ruleId ?? ""} onChange={(event) => setFilters({ ...filters, ruleId: event.target.value || undefined })}>
              <NativeSelectOption value="">—</NativeSelectOption>
              {rules.map((rule) => (
                <NativeSelectOption key={rule.id} value={rule.id}>
                  {ruleDisplayName(rule, t)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        ) : null}
      </div>

      {state === "error" ? (
        <p role="alert" className="text-sm text-danger-text">
          {t.integrationsLoadError}
        </p>
      ) : null}
      {state !== "loading" && rows.length === 0 && state !== "error" ? <p className="text-sm text-fg-3">{t.integrationsLogEmpty}</p> : null}

      <ul className="divide-y divide-line" aria-busy={state === "loading"}>
        {rows.map((delivery) => {
          const meeting = deliveryMeetingLabel(delivery, t.integrationsLogPrivateMeeting)
          const skipKey = delivery.status === "skipped" ? skipReasonKey(delivery.skipReason) : null

          return (
            <li key={delivery.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm" data-delivery-id={delivery.id} data-status={delivery.status}>
              <StatusCell t={t} status={delivery.status} />
              <span className="text-fg">{t[PROVIDER_LABEL_KEYS[delivery.provider]]}</span>
              {meeting ? (
                <span className={meeting.isPrivate ? "text-fg-3" : "min-w-0 truncate text-fg-2"}>
                  {meeting.isPrivate ? meeting.text : <bdi>{meeting.text}</bdi>}
                </span>
              ) : null}
              {skipKey ? (
                <span className="text-xs text-fg-3" data-testid="skip-reason">
                  {im(t, skipKey, { reason: delivery.skipReason })}
                </span>
              ) : null}
              <span className="ms-auto text-xs text-fg-3">
                <When value={formatWhen(locale, delivery.createdAt, timeZone)} />
              </span>
              <Button variant="ghost" size="sm" onClick={() => setDetail(delivery)}>
                {t.integrationsLogDetails}
              </Button>
            </li>
          )
        })}
      </ul>
      {cursor ? (
        <Button variant="ghost" size="sm" className="w-fit" disabled={state === "loading"} onClick={() => void load(cursor)}>
          {t.integrationsPickerLoadMore}
        </Button>
      ) : null}

      <Sheet open={Boolean(detail)} onOpenChange={(open) => !open && setDetail(null)}>
        {detail ? (
          <SheetContent side="end" dir={locale === "he" ? "rtl" : "ltr"} className="w-full sm:max-w-md" closeLabel={t.integrationsClose}>
            <SheetHeader>
              <SheetTitle>{t.integrationsLogDetails}</SheetTitle>
            </SheetHeader>
            <div className="grid gap-2 px-4 text-sm">
              <div className="flex items-center gap-2">
                <div className="sr-only">{t.integrationsLogFilterStatus}</div>
                <div>
                  <StatusCell t={t} status={detail.status} />
                </div>
              </div>
              <div>
                <div className="text-xs text-fg-3">{t.integrationsLogFilterProvider}</div>
                <div className="text-fg">{t[PROVIDER_LABEL_KEYS[detail.provider]]}</div>
              </div>
              {ruleName(detail.ruleId) ? (
                <div>
                  <div className="text-xs text-fg-3">{t.integrationsLogFilterRule}</div>
                  <div className="text-fg">
                    <bdi>{ruleName(detail.ruleId)}</bdi>
                  </div>
                </div>
              ) : null}
              <div className="text-fg-2">{im(t, "integrationsLogAttempts", { attempts: detail.attempts, max: detail.maxAttempts })}</div>
              <div className="text-fg-2">
                <BdiMessage template={t.integrationsLogCreated} values={{ when: formatWhen(locale, detail.createdAt, timeZone) }} />
              </div>
              {detail.completedAt ? (
                <div className="text-fg-2">
                  <BdiMessage template={t.integrationsLogCompleted} values={{ when: formatWhen(locale, detail.completedAt, timeZone) }} />
                </div>
              ) : null}
              {detail.status === "skipped" && skipReasonKey(detail.skipReason) ? (
                <div className="text-fg-2">{im(t, skipReasonKey(detail.skipReason)!, { reason: detail.skipReason })}</div>
              ) : null}
              {deliveryErrorKey(detail.lastError) ? (
                <div className="rounded-md bg-danger-soft p-2 text-xs text-danger-text">{im(t, deliveryErrorKey(detail.lastError)!)}</div>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2 px-4">
              {deliveryExternalUrl(detail) ? (
                <Button variant="secondary" size="sm" render={<a href={deliveryExternalUrl(detail)} target="_blank" rel="noreferrer" />} nativeButton={false}>
                  {im(t, "integrationsLogOpenExternal", { provider: t[PROVIDER_LABEL_KEYS[detail.provider]] })}
                  <ExternalLinkIcon aria-hidden="true" data-icon="inline-end" />
                </Button>
              ) : null}
              {isDeliveryRetryable(detail) ? (
                <Button size="sm" disabled={busy} onClick={() => void retry(detail)}>
                  <RotateCcwIcon aria-hidden="true" data-icon="inline-start" />
                  {t.integrationsLogRetry}
                </Button>
              ) : null}
            </div>
          </SheetContent>
        ) : null}
      </Sheet>
    </div>
  )
}

function WebhookDeliveries({ t, locale, refreshKey }: { t: Dictionary; locale: string; refreshKey: number }) {
  const timeZone = useOptionalI18n()?.timeZone
  const [subscriptions, setSubscriptions] = useState<WebhookSubscriptionView[]>([])
  const [subscriptionId, setSubscriptionId] = useState("")
  const [eventName, setEventName] = useState("")
  const [status, setStatus] = useState("")
  const [rows, setRows] = useState<WebhookDeliveryView[]>([])
  const [limit, setLimit] = useState(25)
  const [state, setState] = useState<"loading" | "idle" | "error">("loading")
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false

    void integrationsApi.webhookSubscriptions().then((result) => {
      if (!cancelled && result.ok) setSubscriptions(result.body)
    })

    return () => {
      cancelled = true
    }
  }, [refreshKey])

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams({ limit: String(limit) })

    if (subscriptionId) params.set("subscriptionId", subscriptionId)
    void integrationsApi.webhookDeliveries(params.toString()).then((result) => {
      if (cancelled) return
      if (!result.ok) {
        setState("error")
        return
      }
      setRows(result.body.deliveries)
      setState("idle")
    })

    return () => {
      cancelled = true
    }
  }, [subscriptionId, limit, refreshKey, nonce])

  async function retry(delivery: WebhookDeliveryView) {
    const result = await integrationsApi.retryWebhookDelivery(delivery.id)

    if (result.ok) toast.success(t.integrationsLogRetried)
    else toast.error(t.integrationsSaveFailed)
    setNonce((value) => value + 1)
  }

  const events = [...new Set(rows.map((row) => row.eventName))]
  const statuses = [...new Set(rows.map((row) => row.status))]
  const visible = rows.filter((row) => (!eventName || row.eventName === eventName) && (!status || row.status === status))

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        <label className="grid gap-1 text-xs text-fg-2">
          {t.integrationsSectionWebhooks}
          <NativeSelect size="sm" value={subscriptionId} onChange={(event) => setSubscriptionId(event.target.value)}>
            <NativeSelectOption value="">—</NativeSelectOption>
            {subscriptions.map((subscription) => (
              <NativeSelectOption key={subscription.id} value={subscription.id}>
                {subscription.url}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label className="grid gap-1 text-xs text-fg-2">
          {t.integrationsWebhooksTestEvent}
          <NativeSelect size="sm" value={eventName} onChange={(event) => setEventName(event.target.value)}>
            <NativeSelectOption value="">—</NativeSelectOption>
            {events.map((name) => (
              <NativeSelectOption key={name} value={name}>
                {name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label className="grid gap-1 text-xs text-fg-2">
          {t.integrationsLogFilterStatus}
          <NativeSelect size="sm" value={status} onChange={(event) => setStatus(event.target.value)}>
            <NativeSelectOption value="">—</NativeSelectOption>
            {statuses.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {statusText(t, value)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      </div>
      {state === "error" ? (
        <p role="alert" className="text-sm text-danger-text">
          {t.integrationsLoadError}
        </p>
      ) : null}
      {state === "idle" && visible.length === 0 ? <p className="text-sm text-fg-3">{t.integrationsLogEmpty}</p> : null}
      <ul className="divide-y divide-line" aria-busy={state === "loading"}>
        {visible.map((delivery) => (
          <li key={delivery.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm" data-webhook-delivery-id={delivery.id} data-status={delivery.status}>
            <StatusCell t={t} status={delivery.status} />
            {delivery.responseStatus ? <span className="font-mono text-xs tabular-nums text-fg-3">{delivery.responseStatus}</span> : null}
            <bdi className="font-mono text-xs text-fg">{delivery.eventName}</bdi>
            <bdi dir="ltr" className="min-w-0 flex-1 truncate font-mono text-xs text-fg-3">
              {delivery.subscriptionUrl}
            </bdi>
            <span className="text-xs text-fg-3">{im(t, "integrationsLogAttempts", { attempts: delivery.attempts, max: delivery.maxAttempts ?? "—" })}</span>
            <span className="text-xs text-fg-3">
              <When value={formatWhen(locale, delivery.createdAt, timeZone)} />
            </span>
            {isWebhookDeliveryRetryable(delivery.status) ? (
              <Button variant="ghost" size="sm" onClick={() => void retry(delivery)}>
                {t.integrationsLogRetry}
              </Button>
            ) : null}
            {delivery.lastError ? (
              <p className="basis-full text-xs text-danger-text">
                <bdi>{delivery.lastError}</bdi>
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {rows.length >= limit && limit < 200 ? (
        <Button variant="ghost" size="sm" className="w-fit" onClick={() => setLimit((value) => Math.min(200, value + 25))}>
          {t.integrationsPickerLoadMore}
        </Button>
      ) : null}
    </div>
  )
}
