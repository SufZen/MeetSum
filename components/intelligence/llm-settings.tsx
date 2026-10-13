"use client"

/**
 * AI model settings (M5 D7): provider preference (with configured state),
 * summary language mode, automatic titles, sentiment and the default
 * template. Stored through `PATCH /api/settings` (Package A owns the keys).
 */
import { useState } from "react"

import { requestJson, useJson } from "@/components/intelligence/use-json"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type { TemplateListItem } from "@/lib/ai/templates/catalog"
import type { Dictionary } from "@/lib/i18n/dictionaries"

export type LlmSettingsProps = {
  /** Disables editing without `settings:write`. */
  readOnly?: boolean
  dictionary: Dictionary
  locale?: string
}

type LlmSettingsValues = {
  llmProviderPreference: "auto" | "anthropic" | "gemini"
  summaryLanguageMode: "meeting" | "he" | "en" | "mixed"
  autoTitleMode: "generic_only" | "always" | "off"
  sentiment: boolean
  summaryTemplate: string
}

type SettingsResponse = { settings: Record<string, unknown> }
type ProvidersResponse = { providers: unknown }

const DEFAULTS: LlmSettingsValues = {
  llmProviderPreference: "auto",
  summaryLanguageMode: "meeting",
  autoTitleMode: "generic_only",
  sentiment: true,
  summaryTemplate: "general",
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function fromSettings(settings: Record<string, unknown>): LlmSettingsValues {
  const features = settings.aiFeatures as { sentiment?: unknown } | undefined

  return {
    llmProviderPreference: pick(settings.llmProviderPreference, ["auto", "anthropic", "gemini"], DEFAULTS.llmProviderPreference),
    summaryLanguageMode: pick(settings.summaryLanguageMode, ["meeting", "he", "en", "mixed"], DEFAULTS.summaryLanguageMode),
    autoTitleMode: pick(settings.autoTitleMode, ["generic_only", "always", "off"], DEFAULTS.autoTitleMode),
    sentiment: features?.sentiment !== false,
    summaryTemplate: typeof settings.summaryTemplate === "string" ? settings.summaryTemplate : DEFAULTS.summaryTemplate,
  }
}

/**
 * Configured LLM providers from the provider status payload; tolerant of
 * its shape (array of `{id|provider, configured}` or a keyed object).
 */
export function configuredProviders(payload: unknown): Record<string, boolean> {
  const result: Record<string, boolean> = {}
  const visit = (entry: unknown, key?: string) => {
    if (!entry || typeof entry !== "object") return
    const record = entry as Record<string, unknown>
    const id = typeof record.id === "string" ? record.id : typeof record.provider === "string" ? record.provider : key

    if (id && typeof record.configured === "boolean") {
      for (const provider of ["anthropic", "gemini"]) {
        if (id.toLowerCase().includes(provider)) result[provider] = result[provider] || record.configured
      }
    }
  }

  if (Array.isArray(payload)) payload.forEach((entry) => visit(entry))
  else if (payload && typeof payload === "object") {
    Object.entries(payload as Record<string, unknown>).forEach(([key, entry]) =>
      Array.isArray(entry) ? entry.forEach((item) => visit(item)) : visit(entry, key)
    )
  }

  return result
}

export function LlmSettings({ readOnly = false, dictionary: t, locale }: LlmSettingsProps) {
  const settings = useJson<SettingsResponse>("/api/settings")
  const providers = useJson<ProvidersResponse>("/api/ai/providers/status")
  const templates = useJson<{ templates: TemplateListItem[] }>("/api/templates")
  const [edits, setEdits] = useState<Partial<LlmSettingsValues>>({})
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle")
  const configured = configuredProviders(providers.data?.providers)
  const he = locale !== "en"
  const values: LlmSettingsValues = {
    ...(settings.data ? fromSettings(settings.data.settings) : DEFAULTS),
    ...edits,
  }

  const update = <K extends keyof LlmSettingsValues>(key: K, value: LlmSettingsValues[K]) => {
    setEdits((previous) => ({ ...previous, [key]: value }))
    setState("idle")
  }

  async function save() {
    setState("saving")
    try {
      await requestJson("/api/settings", {
        method: "PATCH",
        body: {
          llmProviderPreference: values.llmProviderPreference,
          summaryLanguageMode: values.summaryLanguageMode,
          autoTitleMode: values.autoTitleMode,
          summaryTemplate: values.summaryTemplate,
          aiFeatures: {
            ...((settings.data?.settings.aiFeatures as Record<string, unknown> | undefined) ?? {}),
            sentiment: values.sentiment,
          },
        },
      })
      setState("saved")
    } catch {
      setState("failed")
    }
  }

  const status = (provider: "anthropic" | "gemini") =>
    provider in configured ? ` (${configured[provider] ? t.intelConfigured : t.intelNotConfigured})` : ""

  return (
    <section className="ms-card grid gap-4 p-4">
      <h3 className="text-sm font-semibold">{t.intelLlmSettings}</h3>
      {readOnly ? <p className="text-xs text-fg-3">{t.intelReadOnly}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          <span className="text-xs text-fg-3">{t.intelProviderPreference}</span>
          <NativeSelect
            disabled={readOnly}
            value={values.llmProviderPreference}
            onChange={(event) => update("llmProviderPreference", event.target.value as LlmSettingsValues["llmProviderPreference"])}
          >
            <NativeSelectOption value="auto">{t.intelProviderAuto}</NativeSelectOption>
            <NativeSelectOption value="gemini">{`${t.intelProviderGemini}${status("gemini")}`}</NativeSelectOption>
            <NativeSelectOption value="anthropic">{`${t.intelProviderAnthropic}${status("anthropic")}`}</NativeSelectOption>
          </NativeSelect>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-xs text-fg-3">{t.intelLanguageMode}</span>
          <NativeSelect
            disabled={readOnly}
            value={values.summaryLanguageMode}
            onChange={(event) => update("summaryLanguageMode", event.target.value as LlmSettingsValues["summaryLanguageMode"])}
          >
            <NativeSelectOption value="meeting">{t.intelLanguageModeMeeting}</NativeSelectOption>
            <NativeSelectOption value="he">{t.intelLanguageHe}</NativeSelectOption>
            <NativeSelectOption value="en">{t.intelLanguageEn}</NativeSelectOption>
            <NativeSelectOption value="mixed">{t.intelLanguageModeMixed}</NativeSelectOption>
          </NativeSelect>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-xs text-fg-3">{t.intelAutoTitle}</span>
          <NativeSelect
            disabled={readOnly}
            value={values.autoTitleMode}
            onChange={(event) => update("autoTitleMode", event.target.value as LlmSettingsValues["autoTitleMode"])}
          >
            <NativeSelectOption value="generic_only">{t.intelAutoTitleGeneric}</NativeSelectOption>
            <NativeSelectOption value="always">{t.intelAutoTitleAlways}</NativeSelectOption>
            <NativeSelectOption value="off">{t.intelAutoTitleOff}</NativeSelectOption>
          </NativeSelect>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-xs text-fg-3">{t.intelDefaultTemplate}</span>
          <NativeSelect
            disabled={readOnly}
            value={values.summaryTemplate}
            onChange={(event) => update("summaryTemplate", event.target.value)}
          >
            <NativeSelectOption value="auto">{t.intelTemplateAuto}</NativeSelectOption>
            {(templates.data?.templates ?? [])
              .filter((item) => !item.archived)
              .map((item) => (
                <NativeSelectOption key={item.key} value={item.key}>
                  {he ? item.name.he || item.name.en : item.name.en || item.name.he}
                </NativeSelectOption>
              ))}
          </NativeSelect>
        </label>
      </div>
      <label className="inline-flex items-center gap-2 text-sm">
        <Checkbox
          disabled={readOnly}
          checked={values.sentiment}
          onCheckedChange={(checked) => update("sentiment", checked === true)}
        />
        {t.intelSentimentToggle}
      </label>
      {!readOnly ? (
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={state === "saving" || !settings.data} onClick={() => void save()}>
            {t.intelSave}
          </Button>
          {state === "saved" || state === "failed" ? (
            <span role="status" className={`text-xs ${state === "failed" ? "text-danger-text" : "text-fg-3"}`}>
              {state === "failed" ? t.intelSaveFailed : t.intelSaved}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
