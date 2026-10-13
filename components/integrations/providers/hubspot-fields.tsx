"use client"

import { DestinationPicker } from "@/components/integrations/destination-picker"
import { SwitchRow } from "@/components/integrations/pieces"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { RuleDestination } from "@/lib/integrations/core/types"

type HubspotDestination = Extract<RuleDestination, { provider: "hubspot" }>

/** HubSpot rule destination (B3): optional deal, log as meeting/note, tasks and contacts options. */
export function HubspotFields({
  t,
  connectionId,
  value,
  disabled,
  onChange,
}: {
  t: Dictionary
  connectionId: string
  value: HubspotDestination
  disabled?: boolean
  onChange: (value: HubspotDestination) => void
}) {
  return (
    <div className="grid gap-3">
      <DestinationPicker
        t={t}
        connectionId={connectionId}
        picker="deals"
        label={t.integrationsHubspotDeal}
        value={value.dealId ? { id: value.dealId, label: value.dealName ?? "" } : undefined}
        disabled={disabled}
        onChange={(item) => onChange({ ...value, dealId: item.id, dealName: item.label })}
      />
      <label className="grid gap-1 text-sm font-medium text-fg">
        {t.integrationsHubspotLogAs}
        <NativeSelect
          value={value.logAs}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, logAs: event.target.value === "note" ? "note" : "meeting" })}
        >
          <NativeSelectOption value="meeting">{t.integrationsHubspotLogAsMeeting}</NativeSelectOption>
          <NativeSelectOption value="note">{t.integrationsHubspotLogAsNote}</NativeSelectOption>
        </NativeSelect>
      </label>
      <SwitchRow
        id="hubspot-create-tasks"
        label={t.integrationsHubspotCreateTasks}
        checked={value.createTasks}
        disabled={disabled}
        onCheckedChange={(checked) => onChange({ ...value, createTasks: checked })}
      />
      <SwitchRow
        id="hubspot-create-contacts"
        label={t.integrationsHubspotCreateContacts}
        checked={value.createMissingContacts}
        disabled={disabled}
        onCheckedChange={(checked) => onChange({ ...value, createMissingContacts: checked })}
      />
      <SwitchRow
        id="hubspot-match-internal"
        label={t.integrationsHubspotMatchInternal}
        checked={value.matchInternal}
        disabled={disabled}
        onCheckedChange={(checked) => onChange({ ...value, matchInternal: checked })}
      />
    </div>
  )
}
