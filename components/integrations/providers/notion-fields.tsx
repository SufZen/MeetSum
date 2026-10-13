"use client"

import { DestinationPicker } from "@/components/integrations/destination-picker"
import { Input } from "@/components/ui/input"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { RuleDestination } from "@/lib/integrations/core/types"

type NotionDestination = Extract<RuleDestination, { provider: "notion" }>

/** Notion rule destination: a database (C1 search) and an optional title property. */
export function NotionFields({
  t,
  connectionId,
  value,
  disabled,
  onChange,
}: {
  t: Dictionary
  connectionId: string
  value: NotionDestination
  disabled?: boolean
  onChange: (value: NotionDestination) => void
}) {
  return (
    <div className="grid gap-3">
      <DestinationPicker
        t={t}
        connectionId={connectionId}
        picker="databases"
        label={t.integrationsNotionDatabase}
        value={value.databaseId ? { id: value.databaseId, label: value.databaseTitle } : undefined}
        disabled={disabled}
        onChange={(item) => onChange({ ...value, databaseId: item.id, databaseTitle: item.label })}
      />
      <label className="grid gap-1 text-sm font-medium text-fg">
        {t.integrationsNotionTitleProperty}
        <Input
          dir="auto"
          value={value.titleProperty ?? ""}
          disabled={disabled}
          maxLength={100}
          onChange={(event) => onChange({ ...value, titleProperty: event.target.value || undefined })}
        />
      </label>
    </div>
  )
}
