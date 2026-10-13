"use client"

import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { RuleContent } from "@/lib/integrations/core/types"

const TOGGLES = [
  ["overview", "integrationsRuleContentOverview"],
  ["actionItems", "integrationsRuleContentActionItems"],
  ["decisions", "integrationsRuleContentDecisions"],
  ["openQuestions", "integrationsRuleContentOpenQuestions"],
  ["transcript", "integrationsRuleContentTranscript"],
] as const

/** Content toggles shared by rules and the email recap. A rule never creates a share link. */
export function ContentFields({
  t,
  idPrefix,
  value,
  disabled,
  onChange,
}: {
  t: Dictionary
  idPrefix: string
  value: RuleContent
  disabled?: boolean
  onChange: (value: RuleContent) => void
}) {
  return (
    <fieldset className="grid gap-2" disabled={disabled}>
      <legend className="text-sm font-medium text-fg">{t.integrationsRuleContent}</legend>
      <div className="flex flex-wrap gap-2">
        {TOGGLES.map(([key, label]) => (
          <label
            key={key}
            htmlFor={`${idPrefix}-${key}`}
            className="flex h-8 cursor-pointer items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 text-xs font-medium text-fg"
          >
            <input
              id={`${idPrefix}-${key}`}
              type="checkbox"
              className="size-3.5 accent-brand"
              checked={value[key]}
              onChange={(event) => onChange({ ...value, [key]: event.target.checked })}
            />
            {t[label]}
          </label>
        ))}
      </div>
      <label className="grid gap-1 text-sm text-fg">
        {t.integrationsRuleContentLink}
        <NativeSelect
          value={value.link}
          onChange={(event) => {
            const link = event.target.value

            onChange({ ...value, link: link === "existing_share" || link === "none" ? link : "app" })
          }}
        >
          <NativeSelectOption value="app">{t.integrationsRuleContentLinkApp}</NativeSelectOption>
          <NativeSelectOption value="existing_share">{t.integrationsRuleContentLinkShare}</NativeSelectOption>
          <NativeSelectOption value="none">{t.integrationsRuleContentLinkNone}</NativeSelectOption>
        </NativeSelect>
      </label>
    </fieldset>
  )
}
