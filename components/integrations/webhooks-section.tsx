"use client"

import { useCallback, useEffect, useState } from "react"
import { ExternalLinkIcon, KeyRoundIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { BdiMessage } from "@/components/bot/bdi-message"
import { integrationsApi, type WebhookSubscriptionView } from "@/components/integrations/api"
import { im } from "@/components/integrations/messages"
import { IntegrationsSection } from "@/components/integrations/pieces"
import { canUpgradeWebhook, catalogEventsFor, type CatalogEvent } from "@/components/integrations/state"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import type { Dictionary } from "@/lib/i18n/dictionaries"

/** Used until `GET /api/webhooks/catalog` (C4) answers: today's v1 events. */
const FALLBACK_EVENTS: CatalogEvent[] = [
  "meeting.completed",
  "summary.created",
  "action_item.created",
  "meeting.process_failed",
  "realizeos.export.sent",
  "realizeos.export.failed",
].map((name) => ({ name, versions: [1, 2] }))

const DOCS_URL = "https://github.com/SufZen/MeetSum/blob/main/docs/api-reference.md#event-catalog"

type Revealed = { subscriptionId: string; url: string; secret: string }

/**
 * Webhooks (Zapier, n8n): the subscription CRUD moved here from the
 * automations panel (D1), with the C4 event catalog, the payload-version
 * badge and one-way "Upgrade to v2", the signing secret shown once, and a
 * test-fire with an event picker. The delivery history is in the delivery log.
 */
export function WebhooksSection({ t, onChanged }: { t: Dictionary; onChanged?: () => void }) {
  const [subscriptions, setSubscriptions] = useState<WebhookSubscriptionView[]>([])
  const [catalog, setCatalog] = useState<CatalogEvent[]>(FALLBACK_EVENTS)
  const [url, setUrl] = useState("")
  const [selected, setSelected] = useState<string[]>(["meeting.completed", "summary.created"])
  const [testEvent, setTestEvent] = useState<Record<string, string>>({})
  const [revealed, setRevealed] = useState<Revealed>()
  const [busy, setBusy] = useState(false)
  const [upgrading, setUpgrading] = useState<WebhookSubscriptionView | null>(null)
  const [deleting, setDeleting] = useState<WebhookSubscriptionView | null>(null)
  const v2Events = catalogEventsFor(catalog, 2)

  const refresh = useCallback(async () => {
    const [subs, cat] = await Promise.all([integrationsApi.webhookSubscriptions(), integrationsApi.webhookCatalog()])

    if (subs.ok) setSubscriptions(subs.body)
    if (cat.ok && cat.body.events.length) setCatalog(cat.body.events)
  }, [])

  useEffect(() => {
    let cancelled = false

    void Promise.all([integrationsApi.webhookSubscriptions(), integrationsApi.webhookCatalog()]).then(([subs, cat]) => {
      if (cancelled) return
      if (subs.ok) setSubscriptions(subs.body)
      if (cat.ok && cat.body.events.length) setCatalog(cat.body.events)
    })

    return () => {
      cancelled = true
    }
  }, [])

  async function run(action: () => Promise<{ ok: boolean }>, success?: string) {
    setBusy(true)
    const result = await action()

    setBusy(false)
    if (result.ok) {
      if (success) toast.success(success)
    } else toast.error(t.integrationsSaveFailed)
    await refresh()
    onChanged?.()

    return result
  }

  async function create() {
    if (!/^https:\/\//i.test(url.trim())) {
      toast.error(t.integrationsSaveFailed)
      return
    }
    setBusy(true)
    const result = await integrationsApi.createWebhook(url.trim(), selected)

    setBusy(false)
    if (!result.ok) {
      toast.error(t.integrationsSaveFailed)
      return
    }
    if (result.body.secret) setRevealed({ subscriptionId: result.body.subscription.id, url: result.body.subscription.url, secret: result.body.secret })
    setUrl("")
    toast.success(t.integrationsSaved)
    await refresh()
  }

  async function rotate(subscription: WebhookSubscriptionView) {
    setBusy(true)
    const result = await integrationsApi.updateWebhook(subscription.id, { rotateSecret: true })

    setBusy(false)
    if (result.ok && result.body.secret) setRevealed({ subscriptionId: subscription.id, url: subscription.url, secret: result.body.secret })
    else if (!result.ok) toast.error(t.integrationsSaveFailed)
  }

  async function testFire(subscription: WebhookSubscriptionView) {
    const eventName = testEvent[subscription.id] ?? subscription.events[0] ?? "meeting.completed"

    setBusy(true)
    const result = await integrationsApi.testWebhook({ subscriptionId: subscription.id }, eventName)

    setBusy(false)
    if (result.ok) {
      toast.success(`${t.integrationsWebhooksTestFire}: ${result.body.responseStatus ?? result.body.status ?? "ok"}`)
    } else {
      toast.error(`${t.integrationsWebhooksTestFire}: ${t.integrationsStatusFailed}`)
    }
  }

  async function copySecret(secret: string) {
    try {
      await navigator.clipboard.writeText(secret)
      toast.success(t.copied)
    } catch {
      toast.error(t.integrationsSaveFailed)
    }
  }

  return (
    <IntegrationsSection
      id="integrations-webhooks"
      title={t.integrationsSectionWebhooks}
      hint={t.integrationsWebhooksHint}
      action={
        <a href={DOCS_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-brand-text hover:underline">
          {t.integrationsWebhooksDocs}
          <ExternalLinkIcon aria-hidden="true" data-icon="directional" className="size-3.5" />
        </a>
      }
    >
      <div className="ms-card grid gap-3 p-4">
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
          <Input
            dir="ltr"
            type="url"
            value={url}
            aria-label={t.integrationsSectionWebhooks}
            placeholder="https://hooks.zapier.com/… · https://n8n.example/webhook/meetsum"
            onChange={(event) => setUrl(event.target.value)}
          />
          <Button variant="secondary" disabled={busy || !url.trim()} onClick={() => void create()}>
            {t.botInternalDomainsAdd}
          </Button>
        </div>
        <fieldset className="flex flex-wrap gap-1.5">
          <legend className="sr-only">{t.integrationsWebhooksTestEvent}</legend>
          {v2Events.map((event) => (
            <label key={event.name} className="flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-xs text-fg" title={event.description}>
              <input
                type="checkbox"
                className="size-3.5 accent-brand"
                checked={selected.includes(event.name)}
                onChange={() =>
                  setSelected((current) =>
                    current.includes(event.name)
                      ? current.length > 1
                        ? current.filter((name) => name !== event.name)
                        : current
                      : [...current, event.name]
                  )
                }
              />
              <bdi className="font-mono">{event.name}</bdi>
            </label>
          ))}
        </fieldset>

        {revealed ? (
          <div role="status" className="rounded-lg border border-brand bg-brand-soft p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-fg">
              <KeyRoundIcon aria-hidden="true" className="size-4 text-brand-text" />
              {t.integrationsWebhooksSecretOnce}
            </div>
            <p className="mt-1 truncate text-xs text-fg-2">
              <bdi dir="ltr">{revealed.url}</bdi>
            </p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
              <code dir="ltr" className="min-w-0 flex-1 break-all rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-xs text-fg">
                {revealed.secret}
              </code>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="secondary" onClick={() => void copySecret(revealed.secret)}>
                  {t.copy}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRevealed(undefined)}>
                  {t.done}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        <ul className="grid gap-2">
          {subscriptions.map((subscription) => {
            const version = subscription.payloadVersion ?? 1
            const testable = catalogEventsFor(catalog, version as 1 | 2)

            return (
              <li key={subscription.id} className="grid gap-2 rounded-lg border border-line bg-surface-2 p-3" data-webhook-id={subscription.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs text-fg">
                      <bdi dir="ltr">{subscription.url}</bdi>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <span className="rounded-sm border border-line px-1.5 py-0.5 text-2xs font-medium text-fg-2">
                        {im(t, "integrationsWebhooksVersion", { version })}
                      </span>
                      {subscription.events.map((event) => (
                        <bdi key={event} className="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-2xs text-fg-2">
                          {event}
                        </bdi>
                      ))}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Switch
                      checked={subscription.enabled}
                      disabled={busy}
                      aria-label={`${subscription.url}: ${subscription.enabled ? t.integrationsRuleEnabled : t.integrationsRuleDisabled}`}
                      onCheckedChange={(checked) => void run(() => integrationsApi.updateWebhook(subscription.id, { enabled: Boolean(checked) }))}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      title={t.intelRegenerate}
                      aria-label={`${t.intelRegenerate}: ${subscription.url}`}
                      onClick={() => void rotate(subscription)}
                    >
                      <KeyRoundIcon aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      title={t.integrationsRuleDelete}
                      aria-label={`${t.integrationsRuleDelete}: ${subscription.url}`}
                      onClick={() => setDeleting(subscription)}
                    >
                      <Trash2Icon aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-xs text-fg-2">
                    {t.integrationsWebhooksTestEvent}
                    <NativeSelect
                      size="sm"
                      value={testEvent[subscription.id] ?? subscription.events[0] ?? ""}
                      onChange={(event) => setTestEvent((current) => ({ ...current, [subscription.id]: event.target.value }))}
                    >
                      {testable.map((event) => (
                        <NativeSelectOption key={event.name} value={event.name}>
                          {event.name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </label>
                  <Button size="sm" variant="secondary" disabled={busy || !subscription.enabled} onClick={() => void testFire(subscription)}>
                    {t.integrationsWebhooksTestFire}
                  </Button>
                  {canUpgradeWebhook(subscription) ? (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setUpgrading(subscription)}>
                      {t.integrationsWebhooksUpgrade}
                    </Button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      </div>

      <AlertDialog open={Boolean(upgrading)} onOpenChange={(open) => !open && setUpgrading(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.integrationsWebhooksUpgradeConfirm}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.integrationsRuleCancel}</AlertDialogCancel>
            <Button
              disabled={busy}
              onClick={() => {
                const target = upgrading

                setUpgrading(null)
                if (target) void run(() => integrationsApi.updateWebhook(target.id, { payloadVersion: 2 }), t.integrationsSaved)
              }}
            >
              {t.integrationsWebhooksUpgrade}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <BdiMessage template={t.integrationsRuleDeleteConfirm} values={{ name: deleting?.url ?? "" }} />
            </AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.integrationsRuleCancel}</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const target = deleting

                setDeleting(null)
                if (target) {
                  if (revealed?.subscriptionId === target.id) setRevealed(undefined)
                  void run(() => integrationsApi.deleteWebhook(target.id))
                }
              }}
            >
              {t.integrationsRuleDelete}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </IntegrationsSection>
  )
}
