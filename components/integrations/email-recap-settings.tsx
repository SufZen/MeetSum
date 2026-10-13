"use client"

import { useState } from "react"
import { toast } from "sonner"

import { integrationsApi } from "@/components/integrations/api"
import { ContentFields } from "@/components/integrations/content-fields"
import { IntegrationsSection } from "@/components/integrations/pieces"
import { EmailFields } from "@/components/integrations/providers/email-fields"
import { emailRecapDraft, emailRecapRequest, type EmailRecapDraft, type EmailRecapMode } from "@/components/integrations/state"
import { Button } from "@/components/ui/button"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { IntegrationRuleDTO } from "@/lib/integrations/core/types"

const MODES: readonly EmailRecapMode[] = ["off", "all_meetings", "opt_in"]

/**
 * Email recap (A10, the singleton `email` rule): mode, audience, locale and
 * content. When the server has no email sender, the section explains it and
 * stays read-only.
 */
export function EmailRecapSettings({
  t,
  rule,
  emailConfigured,
  onChanged,
}: {
  t: Dictionary
  rule: IntegrationRuleDTO | undefined
  emailConfigured: boolean
  onChanged: () => void
}) {
  const [draft, setDraft] = useState<EmailRecapDraft>(() => emailRecapDraft(rule))
  const [saving, setSaving] = useState(false)
  const disabled = !emailConfigured || saving
  const modeLabel: Record<EmailRecapMode, string> = {
    off: t.integrationsEmailRecapOff,
    all_meetings: t.integrationsEmailRecapAllMeetings,
    opt_in: t.integrationsEmailRecapOptIn,
  }

  async function save() {
    const request = emailRecapRequest(draft, rule)

    if (!request) {
      toast.success(t.integrationsSaved)
      return
    }
    setSaving(true)
    const result =
      request.method === "POST"
        ? await integrationsApi.createRule(request.body)
        : await integrationsApi.updateRule(request.id, request.body)

    setSaving(false)
    if (result.ok) toast.success(t.integrationsSaved)
    else toast.error(result.status === 409 ? t.integrationsRuleCapReached : t.integrationsSaveFailed)
    onChanged()
  }

  return (
    <IntegrationsSection id="integrations-email-recap" title={t.integrationsSectionEmailRecap}>
      <div className="ms-card grid gap-4 p-4">
        {!emailConfigured ? (
          <p role="status" className="rounded-md bg-surface-2 p-3 text-sm text-fg-2">
            {t.integrationsEmailRecapNotConfigured}
          </p>
        ) : null}
        <fieldset className="grid gap-1.5" disabled={disabled}>
          <legend className="text-sm font-medium text-fg">{t.integrationsEmailRecapMode}</legend>
          {MODES.map((mode) => (
            <label key={mode} className="flex items-center gap-2 text-sm text-fg">
              <input
                type="radio"
                name="email-recap-mode"
                className="accent-brand"
                checked={draft.mode === mode}
                onChange={() => setDraft({ ...draft, mode })}
              />
              {modeLabel[mode]}
            </label>
          ))}
        </fieldset>
        {draft.mode !== "off" ? (
          <>
            <EmailFields t={t} value={draft} disabled={disabled} onChange={setDraft} />
            <ContentFields
              t={t}
              idPrefix="email-recap-content"
              value={draft.content}
              disabled={disabled}
              onChange={(content) => setDraft({ ...draft, content })}
            />
          </>
        ) : null}
        <div>
          <Button variant="secondary" disabled={disabled} onClick={() => void save()}>
            {t.integrationsRuleSave}
          </Button>
        </div>
      </div>
    </IntegrationsSection>
  )
}
