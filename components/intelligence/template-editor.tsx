"use client"

/**
 * Workspace summary templates (M5 D6/D7): a list with edit/archive and an
 * editor for key, name, language, base template, model instructions and a
 * sections table, with a preview of the output schema the sections imply.
 * Writes need `settings:write` (the API enforces it).
 */
import { useMemo, useState } from "react"
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react"

import { ApiError, requestJson, useJson } from "@/components/intelligence/use-json"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import type { TemplateListItem } from "@/lib/ai/templates/catalog"
import type { CustomTemplateRecord } from "@/lib/ai/templates/store"
import type { SectionKind, SectionSpec } from "@/lib/ai/templates/types"
import type { Dictionary } from "@/lib/i18n/dictionaries"

export type TemplateEditorProps = {
  /** Template id to edit; omitted to create. */
  templateId?: string
  onSaved?: (template: CustomTemplateRecord) => void
  onCancel?: () => void
  dictionary: Dictionary
  locale?: string
}

const PROMPT_MAX = 4000
const MAX_SECTIONS = 12
const KINDS: SectionKind[] = ["bullets", "paragraph", "table", "qa", "scorecard"]

type Draft = {
  key: string
  name: string
  description: string
  language: "" | "he" | "en"
  baseTemplate: string
  prompt: string
  sections: SectionSpec[]
}

const EMPTY_DRAFT: Draft = {
  key: "",
  name: "",
  description: "",
  language: "",
  baseTemplate: "general",
  prompt: "",
  sections: [],
}

function emptySection(index: number): SectionSpec {
  return { key: `section_${index + 1}`, title: { he: "", en: "" }, kind: "bullets", instructions: "", required: false }
}

/** JSON-schema-like preview of the summary output the sections ask for. */
export function sectionsSchemaPreview(sections: readonly SectionSpec[]) {
  return {
    type: "object",
    properties: {
      overview: { type: "string" },
      sections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { enum: sections.map((section) => section.key) },
            text: { type: "string" },
            items: { type: "array", items: { type: "object", properties: { text: { type: "string" }, refs: { type: "array" } } } },
          },
        },
        required: sections.filter((section) => section.required).map((section) => section.key),
        maxItems: Object.fromEntries(
          sections.filter((section) => section.maxItems).map((section) => [section.key, section.maxItems])
        ),
      },
    },
  }
}

export function TemplateEditor({ templateId, onSaved, onCancel, dictionary: t, locale }: TemplateEditorProps) {
  const existing = useJson<{ template: CustomTemplateRecord }>(
    templateId ? `/api/templates/${encodeURIComponent(templateId)}` : null
  )
  const catalog = useJson<{ templates: TemplateListItem[] }>("/api/templates")
  const [edits, setEdits] = useState<Partial<Draft>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle")
  const he = locale !== "en"
  const loaded = existing.data?.template
  const draft: Draft = {
    ...(loaded
      ? {
          key: loaded.key,
          name: loaded.name,
          description: loaded.description ?? "",
          language: (loaded.language as Draft["language"]) ?? "",
          baseTemplate: loaded.baseTemplate ?? "general",
          prompt: loaded.prompt,
          sections: loaded.sections,
        }
      : EMPTY_DRAFT),
    ...edits,
  }
  const preview = useMemo(() => JSON.stringify(sectionsSchemaPreview(draft.sections), null, 2), [draft.sections])
  const kindLabel: Record<SectionKind, string> = {
    bullets: t.intelKindBullets,
    paragraph: t.intelKindParagraph,
    table: t.intelKindTable,
    qa: t.intelKindQa,
    scorecard: t.intelKindScorecard,
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setEdits((previous) => ({ ...previous, [key]: value }))
  const setSection = (index: number, patch: Partial<SectionSpec>) =>
    set(
      "sections",
      draft.sections.map((section, position) => (position === index ? { ...section, ...patch } : section))
    )
  const move = (index: number, delta: -1 | 1) => {
    const next = [...draft.sections]
    const target = index + delta

    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    set("sections", next)
  }

  async function save() {
    setState("saving")
    setErrors({})
    const body = {
      ...draft,
      language: draft.language || null,
      description: draft.description || null,
      baseTemplate: draft.baseTemplate || null,
    }

    try {
      const response = await requestJson<{ template: CustomTemplateRecord }>(
        templateId ? `/api/templates/${encodeURIComponent(templateId)}` : "/api/templates",
        { method: templateId ? "PATCH" : "POST", body }
      )

      setState("idle")
      onSaved?.(response.template)
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "template_key_exists") {
        setErrors({ key: t.intelTemplateKeyTaken })
      } else if (caught instanceof ApiError) {
        const fieldErrors = (caught.body as { fieldErrors?: Array<{ path: string; message: string }> })?.fieldErrors ?? []

        setErrors(Object.fromEntries(fieldErrors.map((error) => [error.path, error.message])))
      }
      setState("failed")
    }
  }

  const fieldError = (path: string) =>
    errors[path] ? (
      <span role="alert" className="text-xs text-danger-text">
        {errors[path]}
      </span>
    ) : null

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          <span className="text-xs text-fg-3">{t.intelTemplateName}</span>
          <Input dir="auto" value={draft.name} onChange={(event) => set("name", event.target.value)} aria-invalid={Boolean(errors.name)} />
          {fieldError("name")}
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-xs text-fg-3">{t.intelTemplateKey}</span>
          <Input
            dir="ltr"
            value={draft.key}
            // The key is immutable once saved (meetings reference custom:<key>).
            readOnly={Boolean(templateId)}
            onChange={(event) => set("key", event.target.value.toLowerCase())}
            aria-invalid={Boolean(errors.key)}
            aria-describedby="template-key-hint"
          />
          <span id="template-key-hint" className="text-xs text-fg-3">
            {t.intelTemplateKeyHint}
          </span>
          {fieldError("key")}
        </label>
        <label className="grid gap-1 text-sm sm:col-span-2">
          <span className="text-xs text-fg-3">{t.intelTemplateDescription}</span>
          <Input dir="auto" value={draft.description} onChange={(event) => set("description", event.target.value)} />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-xs text-fg-3">{t.intelTemplateLanguage}</span>
          <NativeSelect value={draft.language} onChange={(event) => set("language", event.target.value as Draft["language"])}>
            <NativeSelectOption value="">{t.intelTemplateLanguageAny}</NativeSelectOption>
            <NativeSelectOption value="he">{t.intelLanguageHe}</NativeSelectOption>
            <NativeSelectOption value="en">{t.intelLanguageEn}</NativeSelectOption>
          </NativeSelect>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-xs text-fg-3">{t.intelTemplateBase}</span>
          <NativeSelect value={draft.baseTemplate} onChange={(event) => set("baseTemplate", event.target.value)}>
            {(catalog.data?.templates ?? [])
              .filter((item) => item.builtIn)
              .map((item) => (
                <NativeSelectOption key={item.key} value={item.key}>
                  {he ? item.name.he || item.name.en : item.name.en || item.name.he}
                </NativeSelectOption>
              ))}
          </NativeSelect>
          {fieldError("baseTemplate")}
        </label>
      </div>

      <label className="grid gap-1 text-sm">
        <span className="flex items-baseline justify-between text-xs text-fg-3">
          <span>{t.intelTemplatePrompt}</span>
          <span className="font-mono tabular-nums [direction:ltr] [unicode-bidi:isolate]">
            {draft.prompt.length}/{PROMPT_MAX}
          </span>
        </span>
        <Textarea
          dir="auto"
          rows={5}
          maxLength={PROMPT_MAX}
          value={draft.prompt}
          onChange={(event) => set("prompt", event.target.value)}
        />
        {fieldError("prompt")}
      </label>

      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{t.intelTemplateSections}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={draft.sections.length >= MAX_SECTIONS}
            onClick={() => set("sections", [...draft.sections, emptySection(draft.sections.length)])}
          >
            <PlusIcon data-icon="inline-start" className="size-4" />
            {t.intelTemplateAddSection}
          </Button>
        </div>
        {fieldError("sections")}
        {draft.sections.map((section, index) => (
          <fieldset key={index} className="grid gap-2 rounded-md border border-line p-3 sm:grid-cols-6">
            <label className="grid gap-1 text-xs sm:col-span-2">
              <span className="text-fg-3">{t.intelSectionKey}</span>
              <Input dir="ltr" value={section.key} onChange={(event) => setSection(index, { key: event.target.value })} />
              {fieldError(`sections.${index}.key`)}
            </label>
            <label className="grid gap-1 text-xs sm:col-span-2">
              <span className="text-fg-3">{t.intelSectionTitleHe}</span>
              <Input dir="rtl" value={section.title.he} onChange={(event) => setSection(index, { title: { ...section.title, he: event.target.value } })} />
            </label>
            <label className="grid gap-1 text-xs sm:col-span-2">
              <span className="text-fg-3">{t.intelSectionTitleEn}</span>
              <Input dir="ltr" value={section.title.en} onChange={(event) => setSection(index, { title: { ...section.title, en: event.target.value } })} />
            </label>
            {fieldError(`sections.${index}.title`)}
            <label className="grid gap-1 text-xs sm:col-span-2">
              <span className="text-fg-3">{t.intelSectionKind}</span>
              <NativeSelect value={section.kind} onChange={(event) => setSection(index, { kind: event.target.value as SectionKind })}>
                {KINDS.map((kind) => (
                  <NativeSelectOption key={kind} value={kind}>
                    {kindLabel[kind]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <label className="grid gap-1 text-xs">
              <span className="text-fg-3">{t.intelSectionMaxItems}</span>
              <Input
                type="number"
                min={1}
                max={50}
                value={section.maxItems ?? ""}
                onChange={(event) => setSection(index, { maxItems: event.target.value ? Number(event.target.value) : undefined })}
              />
            </label>
            <label className="inline-flex items-center gap-2 self-end pb-2 text-xs">
              <Checkbox checked={section.required} onCheckedChange={(checked) => setSection(index, { required: checked === true })} />
              {t.intelSectionRequired}
            </label>
            <div className="flex items-end justify-end gap-1 sm:col-span-2">
              <Button size="icon-sm" variant="ghost" aria-label={t.intelMoveUp} disabled={index === 0} onClick={() => move(index, -1)}>
                <ArrowUpIcon className="size-4" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t.intelMoveDown}
                disabled={index === draft.sections.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDownIcon className="size-4" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t.intelRemove}
                onClick={() => set("sections", draft.sections.filter((_, position) => position !== index))}
              >
                <Trash2Icon className="size-4" />
              </Button>
            </div>
            <label className="grid gap-1 text-xs sm:col-span-6">
              <span className="text-fg-3">{t.intelSectionInstructions}</span>
              <Textarea dir="auto" rows={2} value={section.instructions} onChange={(event) => setSection(index, { instructions: event.target.value })} />
            </label>
          </fieldset>
        ))}
      </div>

      <details className="rounded-md border border-line p-3 text-sm">
        <summary className="cursor-pointer text-fg-2">{t.intelSchemaPreview}</summary>
        <pre dir="ltr" className="mt-2 max-h-64 overflow-auto font-mono text-xs text-fg-2">
          {preview}
        </pre>
      </details>

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={state === "saving"} onClick={() => void save()}>
          {t.intelSave}
        </Button>
        {onCancel ? (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t.intelCancel}
          </Button>
        ) : null}
        {state === "failed" && !Object.keys(errors).length ? (
          <span role="status" className="text-xs text-danger-text">
            {t.intelSaveFailed}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/** Settings section: workspace templates list plus the editor. */
export function TemplatesSettings({
  dictionary: t,
  locale,
  readOnly = false,
}: {
  dictionary: Dictionary
  locale?: string
  readOnly?: boolean
}) {
  const { data, reload } = useJson<{ custom: CustomTemplateRecord[] }>("/api/templates")
  const [editing, setEditing] = useState<string | "new" | undefined>()

  async function archive(id: string) {
    await requestJson(`/api/templates/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined)
    void reload()
  }

  return (
    <section className="ms-card grid gap-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t.intelTemplates}</h3>
        {!readOnly && !editing ? (
          <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
            <PlusIcon data-icon="inline-start" className="size-4" />
            {t.intelTemplateNew}
          </Button>
        ) : null}
      </div>
      {readOnly ? <p className="text-xs text-fg-3">{t.intelReadOnly}</p> : null}
      {editing ? (
        <TemplateEditor
          templateId={editing === "new" ? undefined : editing}
          dictionary={t}
          locale={locale}
          onCancel={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined)
            void reload()
          }}
        />
      ) : data?.custom.length ? (
        <ul className="grid gap-1">
          {data.custom.map((template) => (
            <li key={template.id} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-surface-2">
              <span className="min-w-0">
                <bdi className="font-medium">{template.name}</bdi>
                <span className="ms-2 font-mono text-xs text-fg-3 [direction:ltr] [unicode-bidi:isolate]">custom:{template.key}</span>
              </span>
              {!readOnly ? (
                <span className="flex shrink-0 gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(template.id)}>
                    {t.intelTemplateEdit}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void archive(template.id)}>
                    {t.intelTemplateArchive}
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg-3">{t.intelTemplatesEmpty}</p>
      )}
    </section>
  )
}
