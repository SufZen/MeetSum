"use client"

/**
 * Per-meeting summary template (M5 D6/D7): built-ins and workspace
 * templates; "workspace default" clears the override.
 */
import { useState } from "react"

import { requestJson, useJson } from "@/components/intelligence/use-json"
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select"
import type { TemplateListItem } from "@/lib/ai/templates/catalog"
import type { Dictionary } from "@/lib/i18n/dictionaries"

export type TemplatePickerProps = {
  meetingId: string
  /** Current `meetings.template_key`; null/undefined = workspace default. */
  value?: string | null
  onChange?: (templateKey: string | null) => void
  dictionary: Dictionary
  locale?: string
  disabled?: boolean
  className?: string
}

const DEFAULT_VALUE = ""

export function TemplatePicker({
  meetingId,
  value,
  onChange,
  dictionary: t,
  locale,
  disabled,
  className,
}: TemplatePickerProps) {
  const { data } = useJson<{ templates: TemplateListItem[] }>("/api/templates")
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [current, setCurrent] = useState<string | null>(value ?? null)
  const he = locale !== "en"
  const templates = data?.templates ?? []
  const label = (item: TemplateListItem) => (he ? item.name.he || item.name.en : item.name.en || item.name.he)

  async function change(next: string) {
    const templateKey = next === DEFAULT_VALUE ? null : next
    const previous = current

    setCurrent(templateKey)
    setSaving(true)
    setFailed(false)
    try {
      await requestJson(`/api/meetings/${encodeURIComponent(meetingId)}/template`, {
        method: "PATCH",
        body: { templateKey },
      })
      onChange?.(templateKey)
    } catch {
      setCurrent(previous)
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <NativeSelect
        size="sm"
        aria-label={t.intelTemplate}
        className={className}
        value={current ?? DEFAULT_VALUE}
        disabled={disabled || saving}
        onChange={(event) => void change(event.target.value)}
      >
        <NativeSelectOption value={DEFAULT_VALUE}>{t.intelTemplateDefault}</NativeSelectOption>
        <NativeSelectOption value="auto">{t.intelTemplateAuto}</NativeSelectOption>
        <NativeSelectOptGroup label={t.intelTemplateBuiltIn}>
          {templates
            .filter((item) => item.builtIn)
            .map((item) => (
              <NativeSelectOption key={item.key} value={item.key}>
                {label(item)}
              </NativeSelectOption>
            ))}
        </NativeSelectOptGroup>
        {templates.some((item) => !item.builtIn && !item.archived) ? (
          <NativeSelectOptGroup label={t.intelTemplateCustom}>
            {templates
              .filter((item) => !item.builtIn && !item.archived)
              .map((item) => (
                <NativeSelectOption key={item.key} value={item.key}>
                  {label(item)}
                </NativeSelectOption>
              ))}
          </NativeSelectOptGroup>
        ) : null}
      </NativeSelect>
      {failed ? (
        <span role="status" className="text-xs text-danger-text">
          {t.intelTemplateSaveFailed}
        </span>
      ) : null}
    </span>
  )
}
