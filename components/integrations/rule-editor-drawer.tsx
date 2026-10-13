"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"

import { integrationsApi } from "@/components/integrations/api"
import { ContentFields } from "@/components/integrations/content-fields"
import { HubspotFields } from "@/components/integrations/providers/hubspot-fields"
import { NotionFields } from "@/components/integrations/providers/notion-fields"
import { SlackFields } from "@/components/integrations/providers/slack-fields"
import {
  PROVIDER_LABEL_KEYS,
  TRIGGER_KEYS,
  emptyDestination,
  ruleRequestFromDraft,
  validateRuleDraft,
  type DomainMode,
  type RuleDraft,
  type RuleDraftErrors,
} from "@/components/integrations/state"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import { SUPPORTED_LOCALES } from "@/lib/i18n/locales"
import { RULE_TRIGGERS, type IntegrationConnectionDTO } from "@/lib/integrations/core/types"
import type { MeetingSource, MeetingVisibility } from "@/lib/meetings/repository"

const VISIBILITIES: readonly MeetingVisibility[] = ["workspace", "link"]
const SOURCES: readonly MeetingSource[] = [
  "google_meet",
  "teams",
  "zoom",
  "meeting_bot",
  "outlook_calendar",
  "upload",
  "pwa_recorder",
  "desktop_recorder",
]

type Room = { id: string; name: string }

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

function languageName(locale: string, code: string) {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code
  } catch {
    return code
  }
}

/**
 * Rule editor (D1): trigger, filters, destination (searchable pickers),
 * content toggles and "Include private meetings I own". Opens from the inline
 * end so it follows the reading direction.
 */
export function RuleEditorDrawer({
  t,
  locale,
  open,
  initial,
  connections,
  onOpenChange,
  onSaved,
}: {
  t: Dictionary
  locale: string
  open: boolean
  initial: RuleDraft | null
  /** Active workspace connections (slack, notion, hubspot). */
  connections: readonly IntegrationConnectionDTO[]
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<RuleDraft | null>(initial)
  const [errors, setErrors] = useState<RuleDraftErrors>({})
  const [saving, setSaving] = useState(false)
  const [rooms, setRooms] = useState<Room[]>([])
  const [tagsText, setTagsText] = useState(initial?.tagNames.join(", ") ?? "")

  useEffect(() => {
    if (!open) return
    let cancelled = false

    void fetch("/api/rooms", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { rooms: [] }))
      .then((body: { rooms?: Room[] }) => {
        if (!cancelled) setRooms(Array.isArray(body.rooms) ? body.rooms : [])
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [open])

  if (!draft) return null

  const update = (patch: Partial<RuleDraft>) => setDraft((current) => (current ? { ...current, ...patch } : current))
  const side = locale === "he" ? "left" : "right"

  async function save() {
    if (!draft) return
    const next = { ...draft, tagNames: tagsText.split(",").map((tag) => tag.trim()).filter(Boolean) }
    const found = validateRuleDraft(next)

    setErrors(found)
    if (Object.keys(found).length) return
    setSaving(true)
    const request = ruleRequestFromDraft(next)
    const result = next.id ? await integrationsApi.updateRule(next.id, request) : await integrationsApi.createRule(request)

    setSaving(false)
    if (!result.ok) {
      toast.error(result.status === 409 ? t.integrationsRuleCapReached : t.integrationsSaveFailed)
      return
    }
    toast.success(t.integrationsSaved)
    onSaved()
    onOpenChange(false)
  }

  const connectionOptions = connections.filter((connection) => connection.status === "active")

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side={side} className="w-full overflow-y-auto sm:max-w-lg" dir={locale === "he" ? "rtl" : "ltr"}>
        <SheetHeader>
          <SheetTitle>{draft.id ? t.integrationsRuleEdit : t.integrationsRuleNew}</SheetTitle>
          <SheetDescription>{t.integrationsSectionRules}</SheetDescription>
        </SheetHeader>
        <form
          className="grid gap-5 px-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label className="grid gap-1 text-sm font-medium text-fg">
            {t.integrationsRuleName}
            <Input
              dir="auto"
              value={draft.name}
              maxLength={120}
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? "rule-name-error" : undefined}
              onChange={(event) => update({ name: event.target.value })}
            />
            {errors.name ? (
              <span id="rule-name-error" className="text-xs text-danger-text">
                {t[errors.name]}
              </span>
            ) : null}
          </label>

          <label className="grid gap-1 text-sm font-medium text-fg">
            {t.integrationsRuleConnection}
            <NativeSelect
              value={draft.connectionId}
              disabled={Boolean(draft.id)}
              onChange={(event) => {
                const connection = connectionOptions.find((item) => item.id === event.target.value)

                if (!connection) return
                const provider = connection.provider as RuleDraft["provider"]

                update({ connectionId: connection.id, provider, destination: emptyDestination(provider) })
              }}
            >
              {connectionOptions.map((connection) => (
                <NativeSelectOption key={connection.id} value={connection.id}>
                  {`${t[PROVIDER_LABEL_KEYS[connection.provider]]} · ${connection.accountLabel}`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>

          <label className="grid gap-1 text-sm font-medium text-fg">
            {t.integrationsRuleTrigger}
            <NativeSelect
              value={draft.trigger}
              onChange={(event) => {
                const trigger = RULE_TRIGGERS.find((item) => item === event.target.value)

                if (trigger) update({ trigger })
              }}
            >
              {RULE_TRIGGERS.map((trigger) => (
                <NativeSelectOption key={trigger} value={trigger}>
                  {t[TRIGGER_KEYS[trigger]]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>

          <fieldset className="grid gap-3 rounded-md border border-line p-3">
            <legend className="px-1 text-sm font-medium text-fg">{t.integrationsRuleFilters}</legend>
            {rooms.length ? (
              <div className="grid gap-1">
                <span className="text-sm text-fg">{t.integrationsRuleFilterRooms}</span>
                <div className="flex max-h-32 flex-wrap gap-1.5 overflow-auto">
                  {rooms.map((room) => (
                    <label key={room.id} className="flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-xs text-fg">
                      <input
                        type="checkbox"
                        className="size-3.5 accent-brand"
                        checked={draft.roomIds.includes(room.id)}
                        onChange={() => update({ roomIds: toggle(draft.roomIds, room.id) })}
                      />
                      <bdi>{room.name}</bdi>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
            <label className="grid gap-1 text-sm text-fg">
              {t.integrationsRuleFilterTags}
              <Input dir="auto" value={tagsText} onChange={(event) => setTagsText(event.target.value)} />
            </label>
            <div className="grid gap-1">
              <label className="grid gap-1 text-sm text-fg">
                {t.integrationsRuleFilterDomains}
                <NativeSelect
                  value={draft.domainMode}
                  onChange={(event) => update({ domainMode: event.target.value as DomainMode })}
                >
                  <NativeSelectOption value="none">{t.integrationsRuleFilterNone}</NativeSelectOption>
                  <NativeSelectOption value="any_external">{t.integrationsRuleFilterDomainsAnyExternal}</NativeSelectOption>
                  <NativeSelectOption value="includes">{t.integrationsRuleFilterDomainsIncludes}</NativeSelectOption>
                  <NativeSelectOption value="excludes">{t.integrationsRuleFilterDomainsExcludes}</NativeSelectOption>
                </NativeSelect>
              </label>
              {draft.domainMode === "includes" || draft.domainMode === "excludes" ? (
                <Input
                  dir="ltr"
                  value={draft.domainsText}
                  placeholder="example.com, partner.co.il"
                  aria-label={t.integrationsRuleFilterDomains}
                  aria-invalid={Boolean(errors.domains)}
                  onChange={(event) => update({ domainsText: event.target.value })}
                />
              ) : null}
            </div>
            <CheckboxGroup
              legend={t.integrationsRuleFilterVisibility}
              options={VISIBILITIES.map((value) => ({
                value,
                label: value === "workspace" ? t.visibilityWorkspace : t.visibilityLink,
              }))}
              selected={draft.visibility}
              onToggle={(value) => update({ visibility: toggle(draft.visibility, value) })}
            />
            <CheckboxGroup
              legend={t.integrationsRuleFilterLanguages}
              options={SUPPORTED_LOCALES.map((value) => ({ value, label: languageName(locale, value) }))}
              selected={draft.languages}
              onToggle={(value) => update({ languages: toggle(draft.languages, value) })}
            />
            <CheckboxGroup
              legend={t.integrationsRuleFilterSources}
              options={SOURCES.map((value) => ({ value, label: value.replaceAll("_", " ") }))}
              selected={draft.sources}
              onToggle={(value) => update({ sources: toggle(draft.sources, value) })}
            />
            <label className="grid gap-1 text-sm text-fg">
              {t.integrationsRuleFilterMinDuration}
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={1440}
                dir="ltr"
                className="w-32"
                value={draft.minDurationMinutes}
                aria-invalid={Boolean(errors.minDuration)}
                onChange={(event) => update({ minDurationMinutes: event.target.value })}
              />
            </label>
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium text-fg">{t.integrationsRuleDestination}</legend>
            {draft.destination.provider === "slack" ? (
              <SlackFields t={t} connectionId={draft.connectionId} value={draft.destination} onChange={(destination) => update({ destination })} />
            ) : null}
            {draft.destination.provider === "notion" ? (
              <NotionFields t={t} connectionId={draft.connectionId} value={draft.destination} onChange={(destination) => update({ destination })} />
            ) : null}
            {draft.destination.provider === "hubspot" ? (
              <HubspotFields t={t} connectionId={draft.connectionId} value={draft.destination} onChange={(destination) => update({ destination })} />
            ) : null}
            {errors.destination ? (
              <span role="alert" className="text-xs text-danger-text">
                {t[errors.destination]}
              </span>
            ) : null}
          </fieldset>

          <ContentFields t={t} idPrefix="rule-content" value={draft.content} onChange={(content) => update({ content })} />

          <div className="grid gap-1 rounded-md border border-line bg-surface-2 p-3">
            <label className="flex items-start gap-2 text-sm font-medium text-fg">
              <input
                type="checkbox"
                className="mt-1 size-3.5 accent-brand"
                checked={draft.includePrivate}
                aria-describedby="rule-include-private-hint"
                onChange={(event) => update({ includePrivate: event.target.checked })}
              />
              {t.integrationsRuleIncludePrivate}
            </label>
            <p id="rule-include-private-hint" className="ps-5 text-xs text-fg-3">
              {t.integrationsRuleIncludePrivateHint}
            </p>
          </div>
        </form>
        <SheetFooter className="flex-row justify-end">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t.integrationsRuleCancel}
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            {t.integrationsRuleSave}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function CheckboxGroup<T extends string>({
  legend,
  options,
  selected,
  onToggle,
}: {
  legend: string
  options: { value: T; label: string }[]
  selected: readonly string[]
  onToggle: (value: T) => void
}) {
  return (
    <fieldset className="grid gap-1">
      <legend className="text-sm text-fg">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <label key={option.value} className="flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-xs text-fg">
            <input
              type="checkbox"
              className="size-3.5 accent-brand"
              checked={selected.includes(option.value)}
              onChange={() => onToggle(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}
