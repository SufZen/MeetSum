"use client"

import { DestinationPicker } from "@/components/integrations/destination-picker"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { RuleDestination } from "@/lib/integrations/core/types"

type SlackDestination = Extract<RuleDestination, { provider: "slack" }>

/** Slack rule destination: one channel from `conversations.list` (A9). */
export function SlackFields({
  t,
  connectionId,
  value,
  disabled,
  onChange,
}: {
  t: Dictionary
  connectionId: string
  value: SlackDestination
  disabled?: boolean
  onChange: (value: SlackDestination) => void
}) {
  return (
    <DestinationPicker
      t={t}
      connectionId={connectionId}
      picker="channels"
      label={t.integrationsSlackChannel}
      value={value.channelId ? { id: value.channelId, label: value.channelName ? `#${value.channelName.replace(/^#/, "")}` : "" } : undefined}
      disabled={disabled}
      onChange={(item) => onChange({ provider: "slack", channelId: item.id, channelName: item.label.replace(/^#/, "") })}
    />
  )
}
