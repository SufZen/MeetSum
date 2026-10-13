"use client"

import { useCallback, useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { FlaskConicalIcon } from "lucide-react"
import { toast } from "sonner"

import { integrationsApi } from "@/components/integrations/api"
import { DeliveryLog } from "@/components/integrations/delivery-log"
import { EmailRecapSettings } from "@/components/integrations/email-recap-settings"
import { IntegrationsSection } from "@/components/integrations/pieces"
import { PersonalConnections } from "@/components/integrations/personal-connections"
import { ProviderCard } from "@/components/integrations/provider-card"
import { RulesList } from "@/components/integrations/rules-list"
import {
  activeConnectionsFor,
  directionFor,
  findEmailRule,
  integrationErrorKey,
  integrationsReturnTo,
  isWorkspaceProvider,
  providerInfoFor,
  takeIntegrationError,
} from "@/components/integrations/state"
import { WebhooksSection } from "@/components/integrations/webhooks-section"
import { useWorkspace } from "@/components/workspace-context"
import { Button } from "@/components/ui/button"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import {
  WORKSPACE_PROVIDER_IDS,
  type IntegrationConnectionDTO,
  type IntegrationRuleDTO,
  type ProviderInfo,
} from "@/lib/integrations/core/types"

type Loaded = {
  providers: ProviderInfo[]
  connections: IntegrationConnectionDTO[]
  fake: boolean
  rules: IntegrationRuleDTO[]
  realizeosConfigured: boolean | undefined
  teamsCaptureActive: boolean | undefined
}

/**
 * Settings → Integrations (docs/parity/m8.md, D1). One page for every
 * member; what they can do follows their permissions: members see workspace
 * connections' status and manage their own personal connections, admins
 * connect workspace providers and manage rules, email recap and the delivery
 * log, `webhooks:manage` gets the webhook section. Lazy-loaded by the
 * Settings panel; deep link `?panel=settings&section=integrations`.
 */
export function IntegrationsSettings({ dictionary }: { dictionary: Dictionary }) {
  const t = dictionary
  const locale = useParams<{ locale?: string }>()?.locale ?? "en"
  const { can, me } = useWorkspace()
  const isAdmin = can("integrations:manage")
  const canConnect = can("integrations:connect")
  const canWebhooks = can("webhooks:manage")
  const userId = me?.user.id
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error" } | { kind: "ready"; data: Loaded }>({ kind: "loading" })
  const [refreshKey, setRefreshKey] = useState(0)
  const returnTo = integrationsReturnTo(locale)

  const load = useCallback(async (): Promise<Loaded | null> => {
    const [providers, connections, rules, realizeos, teams] = await Promise.all([
      integrationsApi.providers(),
      canConnect ? integrationsApi.connections() : Promise.resolve(undefined),
      isAdmin ? integrationsApi.rules() : Promise.resolve(undefined),
      integrationsApi.realizeosStatus(),
      isAdmin ? integrationsApi.teamsCapture() : Promise.resolve(undefined),
    ])

    if (!providers.ok) return null

    return {
      providers: providers.body,
      connections: connections?.ok ? connections.body.connections : [],
      fake: (connections?.ok && connections.body.fake) || providers.body.some((provider) => provider.fake),
      rules: rules?.ok ? rules.body : [],
      realizeosConfigured: realizeos.ok ? realizeos.body : undefined,
      teamsCaptureActive: teams?.ok ? teams.body : undefined,
    }
  }, [canConnect, isAdmin])

  useEffect(() => {
    let cancelled = false

    void load().then((data) => {
      if (cancelled) return
      setState(data ? { kind: "ready", data } : { kind: "error" })
    })

    return () => {
      cancelled = true
    }
  }, [load, refreshKey])

  // `?integration_error=<code>` from the OAuth callback: toast once, then strip it.
  useEffect(() => {
    const taken = takeIntegrationError(window.location.href)

    if (!taken) return
    const key = integrationErrorKey(taken.code)

    window.history.replaceState(window.history.state, "", taken.cleanHref)
    if (key) toast.error(t[key])
  }, [t])

  const changed = useCallback(() => setRefreshKey((value) => value + 1), [])

  if (state.kind === "loading") {
    return (
      <div aria-busy="true" className="ms-card grid gap-2 p-4 text-sm text-fg-3">
        {t.integrationsLoading}
      </div>
    )
  }

  if (state.kind === "error") {
    return (
      <div role="alert" className="ms-card flex flex-wrap items-center justify-between gap-2 p-4 text-sm text-fg-2">
        {t.integrationsLoadError}
        <Button variant="secondary" size="sm" onClick={changed}>
          {t.integrationsRetry}
        </Button>
      </div>
    )
  }

  const { data } = state
  const emailRule = findEmailRule(data.rules)
  const connectionRules = data.rules.filter((rule) => rule.provider !== "email")
  const workspaceConnections = data.connections.filter((connection) => isWorkspaceProvider(connection.provider))
  const activeWorkspaceConnections = workspaceConnections.filter((connection) => connection.status === "active")
  const emailInfo = providerInfoFor(data.providers, "email")

  return (
    <div dir={directionFor(locale)} className="grid gap-8" data-testid="integrations-settings">
      <header className="grid gap-1">
        <h2 className="text-xl font-semibold text-fg">{t.integrationsTitle}</h2>
        <p className="text-sm text-fg-2">{t.integrationsDescription}</p>
        {data.fake ? (
          <p role="status" data-testid="integrations-fake-banner" className="mt-2 flex items-center gap-2 rounded-md bg-info-soft p-3 text-sm text-info-text">
            <FlaskConicalIcon aria-hidden="true" className="size-4 shrink-0" />
            {t.integrationsTestProvidersBanner}
          </p>
        ) : null}
      </header>

      <IntegrationsSection
        id="integrations-workspace"
        title={t.integrationsSectionWorkspace}
        hint={isAdmin ? t.integrationsSectionWorkspaceHint : t.integrationsMembersSeeStatusOnly}
      >
        <div className="grid gap-3 lg:grid-cols-3">
          {WORKSPACE_PROVIDER_IDS.map((provider) => (
            <ProviderCard
              key={provider}
              t={t}
              locale={locale}
              provider={provider}
              info={providerInfoFor(data.providers, provider)}
              connection={activeConnectionsFor(data.connections, provider)[0]}
              rules={connectionRules}
              canManage={isAdmin}
              returnTo={returnTo}
              onChanged={changed}
            />
          ))}
        </div>
      </IntegrationsSection>

      {canConnect ? (
        <PersonalConnections
          t={t}
          locale={locale}
          userId={userId}
          providers={data.providers}
          connections={data.connections}
          canConnect={canConnect}
          isAdmin={isAdmin}
          teamsCaptureActive={data.teamsCaptureActive}
          returnTo={returnTo}
          onChanged={changed}
        />
      ) : null}

      {isAdmin ? (
        <RulesList
          t={t}
          locale={locale}
          userId={userId}
          rules={connectionRules}
          connections={activeWorkspaceConnections}
          onChanged={changed}
        />
      ) : null}

      {isAdmin ? (
        <EmailRecapSettings
          key={emailRule ? `${emailRule.id}:${emailRule.updatedAt}` : "none"}
          t={t}
          rule={emailRule}
          emailConfigured={emailInfo?.configured ?? false}
          onChanged={changed}
        />
      ) : null}

      {canWebhooks ? <WebhooksSection t={t} onChanged={changed} /> : null}

      {isAdmin ? <DeliveryLog t={t} locale={locale} rules={data.rules} refreshKey={refreshKey} /> : null}

      <IntegrationsSection id="integrations-other" title={t.integrationsSectionOther}>
        <article className="ms-card grid gap-1 p-4" aria-labelledby="integration-card-realizeos">
          <h4 id="integration-card-realizeos" className="text-base font-semibold text-fg">
            {t.integrationsProviderRealizeos}
          </h4>
          <p className="text-sm text-fg-2">
            {data.realizeosConfigured ? t.integrationsProviderRealizeosConfigured : t.integrationsProviderRealizeosNotConfigured}
          </p>
        </article>
      </IntegrationsSection>
    </div>
  )
}
