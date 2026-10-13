/**
 * Per-template output schemas (A6/A7). The core summary schema's section
 * `key` is an enum of the template's model-written section keys; `maxItems`
 * and required sections are enforced in `validate` (one repair retry).
 */
import { z } from "zod"

import { MEETING_TYPES } from "@/lib/ai/templates/builtins"
import { isReservedSectionKey, type SectionSpec, type SummaryTemplateDef } from "@/lib/ai/templates/types"

/** Meeting tag enum (filter tags). Mirrors `MeetingTag`. */
export const MEETING_TAG_VALUES = [
  "technical",
  "finance",
  "real-estate",
  "sales",
  "operations",
  "legal",
  "product",
  "follow-up-needed",
  "urgent",
  "hebrew",
  "english",
  "portuguese",
  "spanish",
  "italian",
  "mixed-language",
] as const

export const TITLE_MAX_CHARS = 60
export const MAX_TOPICS = 8

export const titleTagsTypeSchema = z.object({
  title: z.string(),
  meetingType: z.enum(MEETING_TYPES),
  topics: z.array(z.string()),
  tags: z.array(z.enum(MEETING_TAG_VALUES)),
})

export type TitleTagsTypeOutput = z.infer<typeof titleTagsTypeSchema>

/** Sections the model writes (reserved keys come from the core fields). */
export function modelSections(template: SummaryTemplateDef): SectionSpec[] {
  return template.sections.filter((section) => !isReservedSectionKey(section.key))
}

const citedItem = z.object({
  text: z.string(),
  /** Transcript segment aliases (`s12`). */
  refs: z.array(z.string()),
})

export type CitedItemOutput = z.infer<typeof citedItem>

const actionItem = z.object({
  title: z.string(),
  ownerText: z.string().optional(),
  ownerIsSourceSpeaker: z.boolean().optional(),
  dueText: z.string().optional(),
  /** ISO `YYYY-MM-DD` when the model can resolve the due phrase. */
  dueDate: z.string().optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  confidence: z.number().optional(),
  sourceRef: z.string().optional(),
  sourceQuote: z.string().optional(),
  kind: z.enum(["explicit", "inferred"]).optional(),
})

export type ActionItemOutput = z.infer<typeof actionItem>

const chapter = z.object({
  title: z.string(),
  /** Alias of the chapter's first segment. */
  startRef: z.string(),
  summary: z.string(),
  bullets: z.array(z.string()),
})

export type ChapterOutput = z.infer<typeof chapter>

function sectionKeySchema(keys: string[]) {
  return keys.length ? z.enum(keys as [string, ...string[]]) : z.string()
}

export function buildSummarySchema(template: SummaryTemplateDef) {
  const keys = modelSections(template).map((section) => section.key)

  return z.object({
    overview: z.string(),
    sections: z.array(
      z.object({
        key: sectionKeySchema(keys),
        text: z.string().optional(),
        items: z.array(citedItem),
      })
    ),
    decisions: z.array(citedItem),
    risks: z.array(citedItem),
    openQuestions: z.array(citedItem),
    commitments: z.array(citedItem),
    nextSteps: z.array(citedItem),
    chapters: z.array(chapter),
    actionItems: z.array(actionItem),
    followUpDraft: z.string().optional(),
  })
}

export type SummaryOutput = {
  overview: string
  sections: Array<{ key: string; text?: string; items: CitedItemOutput[] }>
  decisions: CitedItemOutput[]
  risks: CitedItemOutput[]
  openQuestions: CitedItemOutput[]
  commitments: CitedItemOutput[]
  nextSteps: CitedItemOutput[]
  chapters: ChapterOutput[]
  actionItems: ActionItemOutput[]
  followUpDraft?: string
}

/** Semantic checks: maxItems per section and required sections present. */
export function validateSummaryOutput(template: SummaryTemplateDef) {
  const sections = modelSections(template)

  return (value: SummaryOutput): string[] => {
    const errors: string[] = []

    for (const spec of sections) {
      const outputs = value.sections.filter((section) => section.key === spec.key)
      const itemCount = outputs.reduce((sum, section) => sum + section.items.length, 0)

      if (spec.maxItems && itemCount > spec.maxItems) {
        errors.push(`sections.${spec.key}: at most ${spec.maxItems} items (got ${itemCount})`)
      }
      if (spec.required && !outputs.some((section) => section.text?.trim() || section.items.length)) {
        errors.push(`sections.${spec.key}: required section is missing`)
      }
    }

    if (!value.overview.trim()) errors.push("overview: must not be empty")
    return errors
  }
}
