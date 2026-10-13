"use client"

import { useState } from "react"
import { toast } from "sonner"

import { BdiMessage } from "@/components/bot/bdi-message"
import { integrationsApi } from "@/components/integrations/api"
import { DestinationPicker } from "@/components/integrations/destination-picker"
import { im } from "@/components/integrations/messages"
import { ExceptionPill, SwitchRow, When } from "@/components/integrations/pieces"
import {
  DEFAULT_DESTINATIONS,
  PROVIDER_HINT_KEYS,
  PROVIDER_LABEL_KEYS,
  allowsManualSend,
  connectionPill,
  formatWhen,
  oauthStartUrl,
  pickConfig,
  primaryCardAction,
  rulesUsingConnection,
} from "@/components/integrations/state"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type {
  IntegrationConnectionDTO,
  IntegrationRuleDTO,
  ProviderId,
  ProviderInfo,
} from "@/lib/integrations/core/types"

/**
 * One provider card (D1). One primary action: Connect, or Reconnect when the
 * connection is broken. Test and Disconnect are secondary. A pill appears only
 * for `needs_reauth` / `error`. Tokens never reach the client; the account
 * label and last error come redacted from the API.
 */
export function ProviderCard({
  t,
  locale,
  provider,
  info,
  connection,
  rules,
  canManage,
  returnTo,
  onChanged,
  children,
}: {
  t: Dictionary
  locale: string
  provider: ProviderId
  info: ProviderInfo | undefined
  connection: IntegrationConnectionDTO | undefined
  /** Rules that depend on this connection (admins only; members get []). */
  rules: readonly IntegrationRuleDTO[]
  /** The viewer may connect, configure and disconnect this provider. */
  canManage: boolean
  returnTo: string
  onChanged: () => void
  /** Provider-specific extras (Outlook sync, Teams status…). */
  children?: React.ReactNode
}) {
  const [busy, setBusy] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const configured = info?.configured ?? false
  const action = primaryCardAction({ connection, configured, canManage })
  const pill = connectionPill(connection?.status)
  const providerName = t[PROVIDER_LABEL_KEYS[provider]]
  const dependents = connection ? rulesUsingConnection(rules, connection.id) : []
  const defaultDestination = DEFAULT_DESTINATIONS[provider]
  const headingId = `integration-card-${provider}`

  async function test() {
    if (!connection) return
    setBusy(true)
    const result = await integrationsApi.testConnection(connection.id)

    setBusy(false)
    if (result.ok) toast.success(t.integrationsTestOk)
    else toast.error(t.integrationsTestFailed)
    onChanged()
  }

  async function disconnect() {
    if (!connection) return
    setBusy(true)
    const result = await integrationsApi.disconnect(connection.id)

    setBusy(false)
    setConfirmOpen(false)
    if (result.ok) toast.success(t.integrationsDisconnected)
    else toast.error(t.integrationsSaveFailed)
    onChanged()
  }

  async function saveConfig(patch: Record<string, unknown>) {
    if (!connection) return
    setBusy(true)
    const result = await integrationsApi.updateConnection(connection.id, pickConfig(provider, patch))

    setBusy(false)
    if (result.ok) toast.success(t.integrationsSaved)
    else toast.error(t.integrationsSaveFailed)
    onChanged()
  }

  const defaultId = defaultDestination ? connection?.config[defaultDestination.idKey] : undefined
  const defaultLabel = defaultDestination ? connection?.config[defaultDestination.labelKey] : undefined

  return (
    <article aria-labelledby={headingId} className="ms-card grid gap-3 p-4" data-provider={provider}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 id={headingId} className="text-base font-semibold text-fg">
              {providerName}
            </h4>
            {pill ? <ExceptionPill tone={pill.tone}>{t[pill.key]}</ExceptionPill> : null}
          </div>
          <p className="mt-0.5 text-sm text-fg-2">{t[PROVIDER_HINT_KEYS[provider]]}</p>
        </div>
        {action ? (
          <Button
            render={<a href={oauthStartUrl(provider, returnTo)} />}
            nativeButton={false}
            aria-label={`${action === "connect" ? t.integrationsConnect : t.integrationsReconnect}: ${providerName}`}
          >
            {action === "connect" ? t.integrationsConnect : t.integrationsReconnect}
          </Button>
        ) : null}
      </div>

      {!configured && !connection ? <p className="text-sm text-fg-3">{t.integrationsNotConfigured}</p> : null}

      {connection ? (
        <div className="grid gap-1 text-sm text-fg-2">
          <div data-testid="integration-account">
            <BdiMessage template={t.integrationsConnectedAs} values={{ account: connection.accountLabel }} />
          </div>
          <div>
            {connection.lastUsedAt ? (
              <BdiMessage template={t.integrationsLastUsed} values={{ when: <When value={formatWhen(locale, connection.lastUsedAt)} /> }} />
            ) : (
              t.integrationsNeverUsed
            )}
          </div>
          {connection.lastError ? (
            <p className="text-danger-text">{im(t, "integrationsLastError", { error: connection.lastError })}</p>
          ) : null}
        </div>
      ) : null}

      {connection && canManage ? (
        <>
          {defaultDestination && connection.status === "active" ? (
            <details className="rounded-md border border-line bg-surface-2 p-3">
              <summary className="cursor-pointer text-sm font-medium text-fg">
                {t.integrationsDefaultDestination}
                {typeof defaultId === "string" && defaultId ? (
                  <span className="ms-2 font-normal text-fg-2">
                    <bdi>{typeof defaultLabel === "string" && defaultLabel ? defaultLabel : defaultId}</bdi>
                  </span>
                ) : null}
              </summary>
              <div className="mt-3">
                <DestinationPicker
                  t={t}
                  connectionId={connection.id}
                  picker={defaultDestination.picker}
                  label={t[defaultDestination.labelMessage]}
                  value={typeof defaultId === "string" ? { id: defaultId, label: String(defaultLabel ?? "") } : undefined}
                  disabled={busy}
                  onChange={(item) => void saveConfig({ [defaultDestination.idKey]: item.id, [defaultDestination.labelKey]: item.label })}
                />
              </div>
            </details>
          ) : null}
          {defaultDestination ? (
            <SwitchRow
              id={`${headingId}-manual`}
              label={t.integrationsAllowManualSend}
              hint={t.integrationsAllowManualSendHint}
              checked={allowsManualSend(connection)}
              disabled={busy}
              onCheckedChange={(checked) => void saveConfig({ allowManualSend: checked })}
            />
          ) : null}
          {children}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={busy || connection.status === "revoked"} onClick={() => void test()}>
              {busy ? t.integrationsTesting : t.integrationsTest}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmOpen(true)}>
              {t.integrationsDisconnect}
            </Button>
          </div>
        </>
      ) : (
        children
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <BdiMessage template={t.integrationsDisconnectTitle} values={{ provider: providerName }} />
            </AlertDialogTitle>
            <AlertDialogDescription>
              <BdiMessage template={t.integrationsDisconnectBody} values={{ account: connection?.accountLabel ?? "" }} />
            </AlertDialogDescription>
          </AlertDialogHeader>
          {dependents.length ? (
            <div className="grid gap-1 text-sm text-fg-2">
              <p>{im(t, "integrationsDisconnectRulesAffected", { count: dependents.length })}</p>
              <ul className="list-disc ps-5">
                {dependents.map((rule) => (
                  <li key={rule.id}>
                    <bdi>{rule.name}</bdi>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t.integrationsDisconnectCancel}</AlertDialogCancel>
            <Button variant="destructive" disabled={busy} onClick={() => void disconnect()}>
              {t.integrationsDisconnectConfirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </article>
  )
}
