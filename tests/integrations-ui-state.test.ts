import { describe, expect, it } from "vitest"

import {
  activeConnectionsFor,
  canUpgradeWebhook,
  catalogEventsFor,
  connectionPill,
  deliveriesQuery,
  deliveryExternalUrl,
  deliveryMeetingLabel,
  deliveryPill,
  draftFromRule,
  emailRecapDraft,
  emailRecapRequest,
  emptyRuleDraft,
  integrationErrorKey,
  isDeliveryRetryable,
  manualSendTargets,
  meetingControlsState,
  oauthStartUrl,
  outlookSyncStats,
  parseDomains,
  pickConfig,
  primaryCardAction,
  ruleDisabledKey,
  ruleRequestFromDraft,
  rulesUsingConnection,
  skipReasonKey,
  takeIntegrationError,
  validateRuleDraft,
} from "@/components/integrations/state"
import { dictionaries } from "@/lib/i18n/dictionaries"
import {
  INTEGRATION_ERROR_CODES,
  type IntegrationConnectionDTO,
  type IntegrationDeliveryDTO,
  type IntegrationRuleDTO,
} from "@/lib/integrations/core/types"

function connection(overrides: Partial<IntegrationConnectionDTO> = {}): IntegrationConnectionDTO {
  return {
    id: "intc_1",
    provider: "slack",
    status: "active",
    accountLabel: "Acme",
    scopes: [],
    createdAt: "2026-10-01T10:00:00.000Z",
    config: {},
    ...overrides,
  }
}

function rule(overrides: Partial<IntegrationRuleDTO> = {}): IntegrationRuleDTO {
  return {
    id: "intr_1",
    provider: "slack",
    connectionId: "intc_1",
    name: "Sales recaps",
    enabled: true,
    trigger: "meeting.completed",
    filters: {},
    destination: { provider: "slack", channelId: "C1", channelName: "sales" },
    content: { overview: true, actionItems: true, decisions: true, openQuestions: false, transcript: false, link: "app" },
    includePrivate: true,
    createdByUserId: "user_owner",
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  }
}

function delivery(overrides: Partial<IntegrationDeliveryDTO> = {}): IntegrationDeliveryDTO {
  return {
    id: "intd_1",
    provider: "slack",
    origin: "rule",
    status: "sent",
    attempts: 1,
    maxAttempts: 5,
    externalRef: {},
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  }
}

describe("provider cards", () => {
  it("shows a pill only for exceptions", () => {
    expect(connectionPill("active")).toBeNull()
    expect(connectionPill(undefined)).toBeNull()
    expect(connectionPill("revoked")).toBeNull()
    expect(connectionPill("needs_reauth")).toEqual({ tone: "review", key: "integrationsStatusNeedsReauth" })
    expect(connectionPill("error")).toEqual({ tone: "failed", key: "integrationsStatusError" })
  })

  it("has one primary action: Connect, Reconnect when broken, none for members", () => {
    expect(primaryCardAction({ connection: undefined, configured: true, canManage: true })).toBe("connect")
    expect(primaryCardAction({ connection: undefined, configured: false, canManage: true })).toBeNull()
    expect(primaryCardAction({ connection: connection(), configured: true, canManage: true })).toBeNull()
    expect(primaryCardAction({ connection: connection({ status: "needs_reauth" }), configured: true, canManage: true })).toBe("reconnect")
    expect(primaryCardAction({ connection: undefined, configured: true, canManage: false })).toBeNull()
    expect(primaryCardAction({ connection: connection({ status: "error" }), configured: true, canManage: false })).toBeNull()
  })

  it("navigates to oauth/start with an encoded same-origin returnTo", () => {
    expect(oauthStartUrl("slack", "/he?panel=settings&section=integrations")).toBe(
      "/api/integrations/slack/oauth/start?returnTo=%2Fhe%3Fpanel%3Dsettings%26section%3Dintegrations"
    )
  })

  it("lists live connections newest first, optionally per user", () => {
    const list = [
      connection({ id: "a", createdAt: "2026-01-01T00:00:00Z" }),
      connection({ id: "b", createdAt: "2026-02-01T00:00:00Z" }),
      connection({ id: "c", status: "revoked", createdAt: "2026-03-01T00:00:00Z" }),
      connection({ id: "d", provider: "microsoft", userId: "u1" }),
      connection({ id: "e", provider: "microsoft", userId: "u2" }),
    ]

    expect(activeConnectionsFor(list, "slack").map((item) => item.id)).toEqual(["b", "a"])
    expect(activeConnectionsFor(list, "microsoft", "u2").map((item) => item.id)).toEqual(["e"])
  })

  it("only sends allowlisted config keys", () => {
    expect(pickConfig("slack", { defaultChannelId: "C1", allowManualSend: false, accessToken: "x" })).toEqual({
      defaultChannelId: "C1",
      allowManualSend: false,
    })
    expect(pickConfig("google_drive", { anything: 1 })).toEqual({})
  })

  it("reads Outlook sync counts defensively", () => {
    expect(outlookSyncStats(undefined)).toBeUndefined()
    expect(outlookSyncStats(connection({ config: { lastSync: { at: "2026-10-01T00:00:00Z", events: 4, meetings: "x" } } }))).toEqual({
      at: "2026-10-01T00:00:00Z",
      events: 4,
      meetings: undefined,
      errors: undefined,
    })
  })
})

describe("?integration_error", () => {
  it("maps every fixed code to a localized, non-empty message", () => {
    for (const code of INTEGRATION_ERROR_CODES) {
      const key = integrationErrorKey(code)

      expect(key).not.toBeNull()
      expect(dictionaries.en[key!]).not.toBe("")
      expect(dictionaries.he[key!]).not.toBe("")
    }
  })

  it("never reflects unknown values", () => {
    expect(integrationErrorKey("<script>")).toBe("integrationsErrorUnknown")
    expect(integrationErrorKey(null)).toBeNull()
  })

  it("strips only the error param", () => {
    expect(takeIntegrationError("http://x.test/he?panel=settings&section=integrations&integration_error=denied#a")).toEqual({
      code: "denied",
      cleanHref: "/he?panel=settings&section=integrations#a",
    })
    expect(takeIntegrationError("http://x.test/he?panel=settings")).toBeNull()
  })
})

describe("rule editor", () => {
  it("prefills the connection's default destination", () => {
    const draft = emptyRuleDraft(connection({ config: { defaultChannelId: "C9" } }))

    expect(draft.destination).toEqual({ provider: "slack", channelId: "C9", channelName: "C9" })
    expect(draft.visibility).toEqual(["workspace", "link"])
    expect(draft.includePrivate).toBe(false)
  })

  it("validates name, destination, domains and duration", () => {
    const draft = { ...emptyRuleDraft(connection()), domainMode: "includes" as const, domainsText: "not a domain", minDurationMinutes: "-3" }

    expect(validateRuleDraft(draft)).toEqual({
      name: "integrationsRuleValidationName",
      destination: "integrationsRuleValidationDestination",
      domains: "integrationsRuleFilterDomains",
      minDuration: "integrationsRuleFilterMinDuration",
    })
    expect(
      validateRuleDraft({
        ...draft,
        name: "x",
        destination: { provider: "slack", channelId: "C1", channelName: "a" },
        domainsText: "@Acme.com",
        minDurationMinutes: "5",
      })
    ).toEqual({})
  })

  it("builds the request with only the filters that are set", () => {
    const draft = {
      ...emptyRuleDraft(connection()),
      name: "  Weekly  ",
      destination: { provider: "slack" as const, channelId: "C1", channelName: "sales" },
      domainMode: "excludes" as const,
      domainsText: "acme.com, ACME.com partner.co.il",
      minDurationMinutes: "10",
    }

    expect(ruleRequestFromDraft(draft)).toMatchObject({
      provider: "slack",
      connectionId: "intc_1",
      name: "Weekly",
      filters: {
        participantDomains: { mode: "excludes", domains: ["acme.com", "partner.co.il"] },
        visibility: ["workspace", "link"],
        minDurationMinutes: 10,
      },
    })
    expect(ruleRequestFromDraft(draft).filters.roomIds).toBeUndefined()
  })

  it("keeps include_private only for the rule's creator (another admin's edit resets it)", () => {
    expect(draftFromRule(rule(), "user_owner").includePrivate).toBe(true)
    expect(draftFromRule(rule(), "user_admin").includePrivate).toBe(false)
    expect(draftFromRule(rule(), undefined).includePrivate).toBe(false)
  })

  it("parses domains", () => {
    expect(parseDomains("@a.com; B.co.il,,  x  a.com")).toEqual(["a.com", "b.co.il"])
  })

  it("lists the enabled rules a disconnect would turn off and explains disabled ones", () => {
    const rules = [rule(), rule({ id: "r2", enabled: false }), rule({ id: "r3", connectionId: "other" })]

    expect(rulesUsingConnection(rules, "intc_1").map((item) => item.id)).toEqual(["intr_1"])
    expect(ruleDisabledKey(rule())).toBeNull()
    expect(ruleDisabledKey(rule({ enabled: false, disabledReason: "connection_revoked" }))).toBe("integrationsRuleDisabledConnectionRevoked")
    expect(ruleDisabledKey(rule({ enabled: false }))).toBe("integrationsRuleDisabled")
  })
})

describe("email recap", () => {
  const emailRule = rule({
    id: "intr_email",
    provider: "email",
    connectionId: null,
    destination: { provider: "email", audience: "attendees", mode: "opt_in", locale: "he" },
  })

  it("defaults to off with members only", () => {
    expect(emailRecapDraft(undefined)).toMatchObject({ mode: "off", audience: "members", locale: "meeting" })
    expect(emailRecapDraft(emailRule)).toMatchObject({ mode: "opt_in", audience: "attendees", locale: "he" })
    expect(emailRecapDraft({ ...emailRule, enabled: false }).mode).toBe("off")
  })

  it("upserts the singleton rule and disables it for off", () => {
    expect(emailRecapRequest(emailRecapDraft(undefined), undefined)).toBeNull()
    expect(emailRecapRequest({ ...emailRecapDraft(emailRule), mode: "off" }, emailRule)).toEqual({
      method: "PATCH",
      id: "intr_email",
      body: { enabled: false },
    })
    const created = emailRecapRequest({ ...emailRecapDraft(undefined), mode: "all_meetings" }, undefined)

    expect(created).toMatchObject({
      method: "POST",
      body: {
        provider: "email",
        connectionId: null,
        trigger: "meeting.completed",
        includePrivate: false,
        destination: { provider: "email", audience: "members", mode: "all_meetings", locale: "meeting" },
      },
    })
  })
})

describe("delivery log", () => {
  it("retries only failed, partial, or needs_reauth skips", () => {
    expect(isDeliveryRetryable(delivery({ status: "failed" }))).toBe(true)
    expect(isDeliveryRetryable(delivery({ status: "partial" }))).toBe(true)
    expect(isDeliveryRetryable(delivery({ status: "skipped", skipReason: "needs_reauth" }))).toBe(true)
    expect(isDeliveryRetryable(delivery({ status: "skipped", skipReason: "private_meeting" }))).toBe(false)
    expect(isDeliveryRetryable(delivery({ status: "sent" }))).toBe(false)
    expect(isDeliveryRetryable(delivery({ status: "queued" }))).toBe(false)
  })

  it("labels invisible meetings as private and never shows their title", () => {
    expect(deliveryMeetingLabel(delivery({ meetingId: "m1", meetingTitle: null }), "Private meeting")).toEqual({
      text: "Private meeting",
      isPrivate: true,
    })
    expect(deliveryMeetingLabel(delivery({ meetingId: "m1", meetingTitle: "סיכום" }), "Private meeting")).toEqual({
      text: "סיכום",
      isPrivate: false,
    })
    expect(deliveryMeetingLabel(delivery(), "Private meeting")).toBeNull()
  })

  it("only links https external refs of sent deliveries", () => {
    expect(deliveryExternalUrl(delivery({ externalRef: { permalink: "https://acme.slack.com/archives/C1/p1" } }))).toBe(
      "https://acme.slack.com/archives/C1/p1"
    )
    expect(deliveryExternalUrl(delivery({ externalRef: { url: "javascript:alert(1)" } }))).toBeUndefined()
    expect(deliveryExternalUrl(delivery({ status: "failed", externalRef: { url: "https://x.test" } }))).toBeUndefined()
  })

  it("pills only failures", () => {
    expect(deliveryPill("failed")).toBe("failed")
    expect(deliveryPill("partial")).toBe("review")
    expect(deliveryPill("sent")).toBeNull()
    expect(deliveryPill("skipped")).toBeNull()
  })

  it("maps skip reasons, with a generic fallback", () => {
    expect(skipReasonKey("private_meeting")).toBe("integrationsSkipPrivateMeeting")
    expect(skipReasonKey("no_crm_target")).toBe("integrationsSkipNoCrmTarget")
    expect(skipReasonKey("some_future_reason")).toBe("integrationsSkipOther")
    expect(skipReasonKey(undefined)).toBeNull()
  })

  it("builds the A7 query", () => {
    expect(deliveriesQuery({ status: "failed", provider: "", ruleId: "r1" }, "2026-10-01T00:00:00Z", 10)).toBe(
      "status=failed&ruleId=r1&before=2026-10-01T00%3A00%3A00Z&limit=10"
    )
  })
})

describe("webhooks", () => {
  it("filters the catalog by payload version and offers a one-way upgrade", () => {
    const catalog = [
      { name: "meeting.completed", versions: [1, 2] },
      { name: "clip.created", versions: [2] },
    ]

    expect(catalogEventsFor(catalog, 1).map((event) => event.name)).toEqual(["meeting.completed"])
    expect(catalogEventsFor(catalog, 2).map((event) => event.name)).toEqual(["meeting.completed", "clip.created"])
    expect(canUpgradeWebhook({})).toBe(true)
    expect(canUpgradeWebhook({ payloadVersion: 2 })).toBe(false)
  })
})

describe("meeting integration controls", () => {
  const base = { isOwner: false, canManage: false, canWrite: true, emailRecapAvailable: false }

  it("shows the private opt-in to the owner of a private meeting only", () => {
    expect(meetingControlsState({ ...base, visibility: "private", isOwner: true, canManage: true }).showAllowPrivate).toBe(true)
    expect(meetingControlsState({ ...base, visibility: "private", canManage: true }).showAllowPrivate).toBe(false)
    expect(meetingControlsState({ ...base, visibility: "workspace", isOwner: true }).showAllowPrivate).toBe(false)
    // Unknown visibility is treated as private.
    expect(meetingControlsState({ ...base, visibility: undefined, isOwner: true }).showAllowPrivate).toBe(true)
  })

  it("gates email recap on the workspace rule and private meetings on manage", () => {
    expect(meetingControlsState({ ...base, visibility: "workspace" }).showEmailRecap).toBe(false)
    const recap = meetingControlsState({ ...base, visibility: "private", emailRecapAvailable: true })

    expect(recap.showEmailRecap).toBe(true)
    expect(recap.canEditEmailRecap).toBe(false)
    expect(recap.canSend).toBe(false)
    expect(meetingControlsState({ ...base, visibility: "workspace", emailRecapAvailable: true }).canEditEmailRecap).toBe(true)
  })

  it("offers manual sends to active workspace connections that allow them", () => {
    const targets = manualSendTargets([
      connection({ id: "s" }),
      connection({ id: "n", provider: "notion", config: { allowManualSend: false } }),
      connection({ id: "h", provider: "hubspot", status: "needs_reauth" }),
      connection({ id: "m", provider: "microsoft", userId: "u1" }),
    ])

    expect(targets.map((item) => item.id)).toEqual(["s"])
  })
})

describe("review fixes: localized codes and default destination names", () => {
  it("maps skip reasons, error kinds, picker hints, sources and send errors to message keys", async () => {
    const state = await import("@/components/integrations/state")

    expect(state.skipReasonKey("no_recipients")).toBe("integrationsSkipNoRecipients")
    expect(state.skipReasonKey("recap_not_opted_in")).toBe("integrationsSkipNotOptedIn")
    expect(state.deliveryErrorKey("code=unknown kind=retryable")).toBe("integrationsErrorKindRetryable")
    expect(state.deliveryErrorKey("code=forbidden kind=auth provider=slack")).toBe("integrationsErrorKindAuth")
    expect(state.deliveryErrorKey(undefined)).toBeNull()
    expect(state.pickerHintKey("not_member")).toBe("integrationsHintNotMember")
    expect(state.pickerHintKey("appointmentscheduled")).toBe("integrationsDealStageAppointmentScheduled")
    expect(state.pickerHintKey("custom-stage-123")).toBeNull()
    expect(state.sourceLabelKey("outlook_calendar")).toBe("integrationsSourceOutlookCalendar")
    expect(state.sendErrorKey("private_meeting_not_opted_in")).toBe("integrationsSendPrivateNotOptedIn")
    expect(state.sendErrorKey("queue_unavailable")).toBe("integrationsSendQueueUnavailable")
  })

  it("keeps the default destination's name in the connection config", async () => {
    const { pickConfig } = await import("@/components/integrations/state")
    const { validateConfigPatch } = await import("@/lib/integrations/core/connections")

    expect(pickConfig("slack", { defaultChannelId: "C1", defaultChannelName: "#general" })).toEqual({ defaultChannelId: "C1", defaultChannelName: "#general" })
    expect(validateConfigPatch("notion", { defaultDatabaseId: "db", defaultDatabaseTitle: "פגישות" })).toEqual({
      ok: true,
      config: { defaultDatabaseId: "db", defaultDatabaseTitle: "פגישות" },
    })
    expect(validateConfigPatch("hubspot", { defaultDealName: "Renewal" })).toMatchObject({ ok: true })
  })
})
