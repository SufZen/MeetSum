"use client"

import { TriangleAlertIcon } from "lucide-react"

import type { EmailRecapDraft } from "@/components/integrations/state"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type { Dictionary } from "@/lib/i18n/dictionaries"

/**
 * Email recap audience and locale (A10). "Attendees" includes people outside
 * the workspace, so it carries an explicit warning; private meetings always
 * fall back to members on the server.
 */
export function EmailFields({
  t,
  value,
  disabled,
  onChange,
}: {
  t: Dictionary
  value: EmailRecapDraft
  disabled?: boolean
  onChange: (value: EmailRecapDraft) => void
}) {
  return (
    <div className="grid gap-3">
      <fieldset className="grid gap-1.5" disabled={disabled}>
        <legend className="text-sm font-medium text-fg">{t.integrationsEmailRecapAudience}</legend>
        {(["members", "attendees"] as const).map((audience) => (
          <label key={audience} className="flex items-start gap-2 text-sm text-fg">
            <input
              type="radio"
              name="email-recap-audience"
              className="mt-1 accent-brand"
              checked={value.audience === audience}
              onChange={() => onChange({ ...value, audience })}
            />
            {audience === "members" ? t.integrationsEmailRecapMembers : t.integrationsEmailRecapAttendees}
          </label>
        ))}
        {value.audience === "attendees" ? (
          <p role="note" className="flex items-start gap-2 rounded-md bg-warn-soft p-2 text-sm text-warn-text">
            <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t.integrationsEmailRecapAttendeesWarning}
          </p>
        ) : null}
      </fieldset>
      <label className="grid gap-1 text-sm font-medium text-fg">
        {t.integrationsEmailRecapLocale}
        <NativeSelect
          value={value.locale}
          disabled={disabled}
          onChange={(event) => {
            const locale = event.target.value

            onChange({ ...value, locale: locale === "he" || locale === "en" ? locale : "meeting" })
          }}
        >
          <NativeSelectOption value="meeting">{t.integrationsEmailRecapLocaleMeeting}</NativeSelectOption>
          <NativeSelectOption value="he">{t.integrationsEmailRecapLocaleHe}</NativeSelectOption>
          <NativeSelectOption value="en">{t.integrationsEmailRecapLocaleEn}</NativeSelectOption>
        </NativeSelect>
      </label>
    </div>
  )
}
