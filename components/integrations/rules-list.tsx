"use client"

import { useState } from "react"
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { BdiMessage } from "@/components/bot/bdi-message"
import { integrationsApi } from "@/components/integrations/api"
import { IntegrationsSection } from "@/components/integrations/pieces"
import { RuleEditorDrawer } from "@/components/integrations/rule-editor-drawer"
import {
  PROVIDER_LABEL_KEYS,
  TRIGGER_KEYS,
  destinationLabel,
  draftFromRule,
  emptyRuleDraft,
  ruleDisabledKey,
  type RuleDraft,
} from "@/components/integrations/state"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { IntegrationConnectionDTO, IntegrationRuleDTO } from "@/lib/integrations/core/types"

/** Automatic sends (admins only): list, enable toggle, editor drawer, delete. */
export function RulesList({
  t,
  locale,
  userId,
  rules,
  connections,
  onChanged,
}: {
  t: Dictionary
  locale: string
  userId: string | undefined
  /** Connection-backed rules only (the email rule has its own section). */
  rules: readonly IntegrationRuleDTO[]
  /** Active workspace connections a rule may target. */
  connections: readonly IntegrationConnectionDTO[]
  onChanged: () => void
}) {
  const [editor, setEditor] = useState<{ key: string; draft: RuleDraft } | null>(null)
  const [deleting, setDeleting] = useState<IntegrationRuleDTO | null>(null)
  const [busy, setBusy] = useState(false)
  const firstConnection = connections.find((connection) => connection.status === "active")

  async function setEnabled(rule: IntegrationRuleDTO, enabled: boolean) {
    setBusy(true)
    const result = await integrationsApi.updateRule(rule.id, { enabled })

    setBusy(false)
    if (!result.ok) toast.error(result.status === 409 ? t.integrationsRuleCapReached : t.integrationsSaveFailed)
    onChanged()
  }

  async function confirmDelete() {
    if (!deleting) return
    setBusy(true)
    const result = await integrationsApi.deleteRule(deleting.id)

    setBusy(false)
    setDeleting(null)
    if (!result.ok) toast.error(t.integrationsSaveFailed)
    onChanged()
  }

  return (
    <IntegrationsSection
      id="integrations-rules"
      title={t.integrationsSectionRules}
      action={
        firstConnection ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setEditor({ key: `new-${Date.now()}`, draft: emptyRuleDraft(firstConnection) })}
          >
            <PlusIcon data-icon="inline-start" aria-hidden="true" />
            {t.integrationsRuleNew}
          </Button>
        ) : null
      }
    >
      {rules.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line bg-surface-2 p-4 text-sm text-fg-2">{t.integrationsRulesEmpty}</p>
      ) : (
        <ul className="ms-card divide-y divide-line">
          {rules.map((rule) => {
            const disabledKey = ruleDisabledKey(rule)
            const destination = destinationLabel(rule.destination)

            return (
              <li key={rule.id} className="flex flex-wrap items-center gap-3 p-3" data-rule-id={rule.id}>
                <Switch
                  checked={rule.enabled}
                  disabled={busy}
                  aria-label={`${rule.name}: ${rule.enabled ? t.integrationsRuleEnabled : t.integrationsRuleDisabled}`}
                  onCheckedChange={(checked) => void setEnabled(rule, Boolean(checked))}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-fg">
                    <bdi>{rule.name}</bdi>
                  </div>
                  <div className="text-xs text-fg-2">
                    {t[PROVIDER_LABEL_KEYS[rule.provider]]}
                    {destination ? (
                      <>
                        {" · "}
                        <bdi>{destination}</bdi>
                      </>
                    ) : null}
                    {" · "}
                    {t[TRIGGER_KEYS[rule.trigger]]}
                  </div>
                  {disabledKey && disabledKey !== "integrationsRuleDisabled" ? (
                    <div className="text-xs text-warn-text" data-testid="rule-disabled-reason">
                      {t[disabledKey]}
                    </div>
                  ) : null}
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${t.integrationsRuleEdit}: ${rule.name}`}
                    title={t.integrationsRuleEdit}
                    onClick={() => setEditor({ key: rule.id, draft: draftFromRule(rule, userId) })}
                  >
                    <PencilIcon aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${t.integrationsRuleDelete}: ${rule.name}`}
                    title={t.integrationsRuleDelete}
                    onClick={() => setDeleting(rule)}
                  >
                    <Trash2Icon aria-hidden="true" />
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {editor ? (
        <RuleEditorDrawer
          key={editor.key}
          t={t}
          locale={locale}
          open
          initial={editor.draft}
          connections={connections}
          onOpenChange={(open) => {
            if (!open) setEditor(null)
          }}
          onSaved={onChanged}
        />
      ) : null}

      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <BdiMessage template={t.integrationsRuleDeleteConfirm} values={{ name: deleting?.name ?? "" }} />
            </AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.integrationsRuleCancel}</AlertDialogCancel>
            <Button variant="destructive" disabled={busy} onClick={() => void confirmDelete()}>
              {t.integrationsRuleDelete}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </IntegrationsSection>
  )
}
