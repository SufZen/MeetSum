"use client"

import { useState } from "react"
import { toast } from "sonner"

import { BdiMessage } from "@/components/bot/bdi-message"
import { integrationsApi } from "@/components/integrations/api"
import { im } from "@/components/integrations/messages"
import { ExceptionPill, IntegrationsSection, SwitchRow, When } from "@/components/integrations/pieces"
import { ProviderCard } from "@/components/integrations/provider-card"
import {
  PROVIDER_LABEL_KEYS,
  activeConnectionsFor,
  connectionPill,
  formatWhen,
  outlookSyncStats,
  providerInfoFor,
} from "@/components/integrations/state"
import { Button } from "@/components/ui/button"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import { PERSONAL_PROVIDER_IDS, type IntegrationConnectionDTO, type ProviderInfo } from "@/lib/integrations/core/types"

/**
 * Personal connections (D1): Microsoft Outlook (calendar sync into the M7 bot
 * rules, plus the read-only Teams capture status) and Google Drive (Docs
 * export). Every member with `integrations:connect` manages their own; admins
 * also see other members' connections (label and status) and can revoke them.
 */
export function PersonalConnections({
  t,
  locale,
  userId,
  providers,
  connections,
  canConnect,
  isAdmin,
  teamsCaptureActive,
  returnTo,
  onChanged,
}: {
  t: Dictionary
  locale: string
  userId: string | undefined
  providers: readonly ProviderInfo[]
  connections: readonly IntegrationConnectionDTO[]
  canConnect: boolean
  isAdmin: boolean
  /** `undefined` when the viewer can't see the Teams capture status. */
  teamsCaptureActive: boolean | undefined
  returnTo: string
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const mine = (provider: (typeof PERSONAL_PROVIDER_IDS)[number]) =>
    userId ? activeConnectionsFor(connections, provider, userId)[0] : undefined
  const microsoft = mine("microsoft")
  const stats = outlookSyncStats(microsoft)
  const others = connections.filter(
    (connection) =>
      (PERSONAL_PROVIDER_IDS as readonly string[]).includes(connection.provider) &&
      connection.status !== "revoked" &&
      connection.userId !== userId
  )

  async function setSync(enabled: boolean) {
    if (!microsoft) return
    setBusy(true)
    const result = await integrationsApi.updateConnection(microsoft.id, { calendarSyncEnabled: enabled })

    setBusy(false)
    if (result.ok) toast.success(t.integrationsSaved)
    else toast.error(t.integrationsSaveFailed)
    onChanged()
  }

  async function revoke(connection: IntegrationConnectionDTO) {
    setBusy(true)
    const result = await integrationsApi.disconnect(connection.id)

    setBusy(false)
    if (result.ok) toast.success(t.integrationsDisconnected)
    else toast.error(t.integrationsSaveFailed)
    onChanged()
  }

  return (
    <IntegrationsSection id="integrations-personal" title={t.integrationsSectionPersonal} hint={t.integrationsSectionPersonalHint}>
      <div className="grid gap-3 lg:grid-cols-2">
        <ProviderCard
          t={t}
          locale={locale}
          provider="microsoft"
          info={providerInfoFor(providers, "microsoft")}
          connection={microsoft}
          rules={[]}
          canManage={canConnect}
          returnTo={returnTo}
          onChanged={onChanged}
        >
          {microsoft && canConnect ? (
            <div className="grid gap-2 rounded-md border border-line bg-surface-2 p-3">
              <SwitchRow
                id="integrations-outlook-sync"
                label={t.integrationsOutlookSync}
                hint={t.integrationsOutlookSyncHint}
                checked={microsoft.config.calendarSyncEnabled === true}
                disabled={busy || microsoft.status !== "active"}
                onCheckedChange={(checked) => void setSync(checked)}
              />
              <p className="text-xs text-fg-3">
                {stats?.at ? (
                  <BdiMessage template={t.integrationsOutlookLastSync} values={{ when: <When value={formatWhen(locale, stats.at)} /> }} />
                ) : (
                  t.integrationsOutlookNeverSynced
                )}
                {stats?.at ? (
                  <>
                    {" · "}
                    {im(t, "integrationsOutlookEvents", { count: stats.events ?? 0 })}
                    {" · "}
                    {im(t, "integrationsOutlookMeetings", { count: stats.meetings ?? 0 })}
                    {stats.errors ? (
                      <span className="text-danger-text">
                        {" · "}
                        {im(t, "integrationsOutlookErrors", { count: stats.errors })}
                      </span>
                    ) : null}
                  </>
                ) : null}
              </p>
            </div>
          ) : null}
          {teamsCaptureActive !== undefined ? (
            <p className="text-xs text-fg-3">
              {t.integrationsTeamsCaptureStatus}:{" "}
              {teamsCaptureActive ? t.integrationsTeamsCaptureActive : t.integrationsTeamsCaptureInactive}
            </p>
          ) : null}
        </ProviderCard>
        <ProviderCard
          t={t}
          locale={locale}
          provider="google_drive"
          info={providerInfoFor(providers, "google_drive")}
          connection={mine("google_drive")}
          rules={[]}
          canManage={canConnect}
          returnTo={returnTo}
          onChanged={onChanged}
        >
          <p className="text-xs text-fg-3">{t.integrationsGoogleDriveHint}</p>
        </ProviderCard>
      </div>

      {isAdmin && others.length ? (
        <div className="ms-card grid gap-2 p-4">
          <h4 className="text-sm font-semibold text-fg">{t.integrationsPersonalOtherUsers}</h4>
          <ul className="grid gap-1">
            {others.map((connection) => {
              const pill = connectionPill(connection.status)

              return (
                <li key={connection.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 text-fg-2">
                    {t[PROVIDER_LABEL_KEYS[connection.provider]]}: <bdi className="text-fg">{connection.accountLabel}</bdi>
                    {pill ? (
                      <span className="ms-2">
                        <ExceptionPill tone={pill.tone}>{t[pill.key]}</ExceptionPill>
                      </span>
                    ) : null}
                  </span>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void revoke(connection)}>
                    {t.integrationsDisconnect}
                  </Button>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </IntegrationsSection>
  )
}
