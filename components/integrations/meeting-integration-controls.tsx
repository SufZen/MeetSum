"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { SendIcon } from "lucide-react"
import { toast } from "sonner"

import { integrationsApi, type MeetingPrefsResponse } from "@/components/integrations/api"
import {
  DELIVERY_STATUS_KEYS,
  PROVIDER_LABEL_KEYS,
  isTerminalDelivery,
  manualSendTargets,
  meetingControlsState,
  newIdempotencyKey,
} from "@/components/integrations/state"
import { useWorkspace } from "@/components/workspace-context"
import {
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import { getDictionary, type Dictionary } from "@/lib/i18n/dictionaries"
import { SUPPORTED_LOCALES, type SupportedLocale } from "@/lib/i18n/locales"
import type { EmailRecapPreference, IntegrationConnectionDTO } from "@/lib/integrations/core/types"
import type { MeetingVisibility } from "@/lib/meetings/repository"

const RECAP_OPTIONS: readonly EmailRecapPreference[] = ["inherit", "on", "off"]
const POLL_MS = 1500
const POLL_TRIES = 8

/**
 * Per-meeting integration controls in the meeting header ⋯ menu (D2):
 * - "Send to…" (manual send to Slack, Notion or HubSpot; A6, with an
 *   `Idempotency-Key`), then a status toast;
 * - "Allow integrations for this private meeting" (owner only, private only);
 * - "Email recap" inherit / on / off (when the workspace recap rule exists).
 * Mounted inside the menu content, so it loads when the menu opens.
 */
export function MeetingIntegrationControls({
  meetingId,
  visibility,
  isOwner,
  canManage,
}: {
  meetingId: string
  visibility: MeetingVisibility | undefined
  /** The signed-in user owns the meeting (only the owner may opt a private meeting in). */
  isOwner: boolean
  canManage: boolean
}) {
  const params = useParams<{ locale?: string }>()
  const locale = (SUPPORTED_LOCALES as readonly string[]).includes(params?.locale ?? "")
    ? (params?.locale as SupportedLocale)
    : "en"
  const t: Dictionary = getDictionary(locale)
  const { can } = useWorkspace()
  const canWrite = can("meeting:write")
  const canConnect = can("integrations:connect")
  const [prefs, setPrefs] = useState<MeetingPrefsResponse | null>(null)
  const [targets, setTargets] = useState<IntegrationConnectionDTO[]>([])
  const [busy, setBusy] = useState(false)
  const controls = meetingControlsState({
    visibility,
    isOwner,
    canManage,
    canWrite,
    emailRecapAvailable: Boolean(prefs?.emailRecapAvailable),
  })

  useEffect(() => {
    let cancelled = false

    void integrationsApi.meetingPrefs(meetingId).then((result) => {
      if (!cancelled && result.ok) setPrefs(result.body)
    })
    if (canConnect) {
      void integrationsApi.connections().then((result) => {
        if (!cancelled && result.ok) setTargets(manualSendTargets(result.body.connections))
      })
    }

    return () => {
      cancelled = true
    }
  }, [meetingId, canConnect])

  async function update(patch: { allowPrivatePush?: boolean; emailRecap?: EmailRecapPreference }) {
    if (!prefs) return
    const previous = prefs

    setBusy(true)
    setPrefs({ ...prefs, prefs: { ...prefs.prefs, ...patch } })
    const result = await integrationsApi.updateMeetingPrefs(meetingId, patch)

    setBusy(false)
    if (result.ok) {
      toast.success(t.integrationsMeetingSaved)
    } else {
      setPrefs(previous)
      toast.error(t.integrationsSaveFailed)
    }
  }

  async function send(connection: IntegrationConnectionDTO) {
    const providerName = t[PROVIDER_LABEL_KEYS[connection.provider]]
    const result = await integrationsApi.sendMeeting(meetingId, connection.id, newIdempotencyKey())

    if (!result.ok) {
      toast.error(`${providerName}: ${t.integrationsStatusFailed}`)
      return
    }
    toast.info(`${providerName}: ${t.integrationsStatusQueued}`)

    for (let attempt = 0; attempt < POLL_TRIES; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      const delivery = await integrationsApi.delivery(result.body.deliveryId)

      if (!delivery.ok) return
      if (isTerminalDelivery(delivery.body.status)) {
        const label = `${providerName}: ${t[DELIVERY_STATUS_KEYS[delivery.body.status]]}`

        if (delivery.body.status === "sent") toast.success(label)
        else toast.error(label)
        return
      }
    }
  }

  const showSend = controls.canSend && targets.length > 0
  const showRecap = controls.showEmailRecap && prefs !== null

  if (!showSend && !(controls.showAllowPrivate && prefs) && !showRecap) return null

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>{t.integrationsMeetingControls}</DropdownMenuLabel>
        {showSend ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <SendIcon aria-hidden="true" data-icon="directional" />
              {t.exportSendTo || t.integrationsRuleDestination}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {targets.map((connection) => (
                <DropdownMenuItem key={connection.id} onClick={() => void send(connection)}>
                  <span>{t[PROVIDER_LABEL_KEYS[connection.provider]]}</span>
                  <bdi className="ms-auto text-xs text-fg-3">{connection.accountLabel}</bdi>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {controls.showAllowPrivate && prefs ? (
          <DropdownMenuCheckboxItem
            checked={prefs.prefs.allowPrivatePush}
            disabled={busy}
            closeOnClick={false}
            onCheckedChange={(checked) => void update({ allowPrivatePush: Boolean(checked) })}
          >
            <span className="grid max-w-64">
              <span>{t.integrationsMeetingAllowPrivate}</span>
              <span className="text-xs text-fg-3">{t.integrationsMeetingAllowPrivateHint}</span>
            </span>
          </DropdownMenuCheckboxItem>
        ) : null}
      </DropdownMenuGroup>
      {showRecap ? (
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t.integrationsMeetingEmailRecap}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={prefs.prefs.emailRecap}
            onValueChange={(value) => {
              const next = RECAP_OPTIONS.find((option) => option === value)

              if (next && next !== prefs.prefs.emailRecap) void update({ emailRecap: next })
            }}
          >
            {RECAP_OPTIONS.map((option) => (
              <DropdownMenuRadioItem key={option} value={option} disabled={busy || !controls.canEditEmailRecap} closeOnClick={false}>
                {option === "inherit"
                  ? t.integrationsMeetingEmailRecapInherit
                  : option === "on"
                    ? t.integrationsMeetingEmailRecapOn
                    : t.integrationsMeetingEmailRecapOff}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      ) : null}
    </>
  )
}
