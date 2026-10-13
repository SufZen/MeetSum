/**
 * Workspace summary templates in `summary_templates` (M5 D6). Postgres when
 * `MEETSUM_STORAGE=postgres`, otherwise in memory. Every query is filtered by
 * workspace id; templates are referenced as `custom:<key>` and extend a
 * built-in (`base_template`).
 *
 * Validation: key slug `^[a-z0-9-]{2,40}$`, prompt ≤ 4000 characters,
 * at most 12 sections, each a valid `SectionSpec` with a unique key.
 */
import { z } from "zod"

import {
  BUILT_IN_TEMPLATE_KEYS,
  CUSTOM_TEMPLATE_PREFIX,
  type SectionSpec,
} from "@/lib/ai/templates/types"
import { getDatabasePool, type Queryable } from "@/lib/db/client"

export type CustomTemplateRecord = {
  id: string
  workspaceId: string
  /** Slug `^[a-z0-9-]{2,40}$`; referenced as `custom:<key>`. */
  key: string
  name: string
  description?: string
  language?: string
  baseTemplate?: string
  /** At most 4000 characters. */
  prompt: string
  /** At most 12. */
  sections: SectionSpec[]
  createdByUserId?: string
  archivedAt?: string
  createdAt: string
  updatedAt: string
}

export type SaveCustomTemplateInput = {
  /** Existing template id to update; omitted to create. */
  id?: string
  key: string
  name: string
  description?: string
  language?: string
  baseTemplate?: string
  prompt: string
  sections: SectionSpec[]
}

export const TEMPLATE_LIMITS = {
  keyPattern: /^[a-z0-9-]{2,40}$/,
  promptMaxChars: 4000,
  maxSections: 12,
  nameMaxChars: 120,
  descriptionMaxChars: 500,
  sectionTitleMaxChars: 80,
  sectionInstructionsMaxChars: 1000,
  sectionMaxItems: 50,
} as const

export type TemplateFieldError = { path: string; message: string }

/** Invalid template payload (route → 400 with field errors). */
export class TemplateValidationError extends Error {
  readonly errors: TemplateFieldError[]

  constructor(errors: TemplateFieldError[]) {
    super("Invalid template")
    this.name = "TemplateValidationError"
    this.errors = errors
  }
}

/** Another template of the workspace already uses the key (route → 409). */
export class TemplateKeyConflictError extends Error {
  constructor(key: string) {
    super(`Template key already exists: ${key}`)
    this.name = "TemplateKeyConflictError"
  }
}

/** No such template in the workspace (route → 404). */
export class TemplateNotFoundError extends Error {
  constructor(id: string) {
    super(`Template not found: ${id}`)
    this.name = "TemplateNotFoundError"
  }
}

const text = (max: number) => z.string().trim().max(max, `must be at most ${max} characters`)

const sectionSchema = z
  .object({
    key: z.string().trim().regex(/^[a-z0-9_]{1,40}$/, "must be a slug of a-z, 0-9 and _ (1-40)"),
    title: z.object({
      he: text(TEMPLATE_LIMITS.sectionTitleMaxChars).default(""),
      en: text(TEMPLATE_LIMITS.sectionTitleMaxChars).default(""),
    }),
    kind: z.enum(["bullets", "paragraph", "table", "qa", "scorecard"]),
    instructions: text(TEMPLATE_LIMITS.sectionInstructionsMaxChars).default(""),
    maxItems: z.number().int().min(1).max(TEMPLATE_LIMITS.sectionMaxItems).optional(),
    required: z.boolean().default(false),
  })
  .refine((section) => section.title.he || section.title.en, {
    message: "needs a Hebrew or English title",
    path: ["title"],
  })
  .transform(
    (section): SectionSpec => ({
      key: section.key,
      title: { he: section.title.he || section.title.en, en: section.title.en || section.title.he },
      kind: section.kind,
      instructions: section.instructions,
      ...(section.maxItems === undefined ? {} : { maxItems: section.maxItems }),
      required: section.required,
    })
  )

const optionalText = (max: number) =>
  z
    .union([text(max), z.null()])
    .optional()
    .transform((value) => (value ? value : undefined))

const templateSchema = z
  .object({
    key: z.string().trim().regex(TEMPLATE_LIMITS.keyPattern, "must match ^[a-z0-9-]{2,40}$"),
    name: text(TEMPLATE_LIMITS.nameMaxChars).min(1, "must not be empty"),
    description: optionalText(TEMPLATE_LIMITS.descriptionMaxChars),
    language: z
      .union([z.enum(["he", "en"]), z.null()])
      .optional()
      .transform((value) => value ?? undefined),
    baseTemplate: z
      .union([z.enum(BUILT_IN_TEMPLATE_KEYS), z.null()])
      .optional()
      .transform((value) => value ?? undefined),
    prompt: z
      .string()
      .max(TEMPLATE_LIMITS.promptMaxChars, `must be at most ${TEMPLATE_LIMITS.promptMaxChars} characters`)
      .default("")
      .transform((value) => value.trim()),
    sections: z
      .array(sectionSchema)
      .max(TEMPLATE_LIMITS.maxSections, `must have at most ${TEMPLATE_LIMITS.maxSections} sections`)
      .default([]),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>()

    value.sections.forEach((section, index) => {
      if (seen.has(section.key)) {
        ctx.addIssue({ code: "custom", message: "is a duplicate", path: ["sections", index, "key"] })
      }
      seen.add(section.key)
    })
  })

export type ParsedTemplateInput = Omit<SaveCustomTemplateInput, "id">

/** Validates and normalizes a template payload. */
export function parseTemplateInput(
  value: unknown
): { ok: true; input: ParsedTemplateInput } | { ok: false; errors: TemplateFieldError[] } {
  const result = templateSchema.safeParse(value)

  if (result.success) return { ok: true, input: result.data }

  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  }
}

/** `custom:<key>` of a stored template. */
export function customTemplateKey(key: string): string {
  return `${CUSTOM_TEMPLATE_PREFIX}${key}`
}

/* ------------------------------------------------------------ backends */

export type TemplateStoreDeps = { client?: Queryable }

const memoryTemplates = new Map<string, CustomTemplateRecord>()

/** Test hook: clears the in-memory store. */
export function resetMemoryTemplates() {
  memoryTemplates.clear()
}

function resolveClient(deps: TemplateStoreDeps): Queryable | undefined {
  if (deps.client) return deps.client

  return process.env.MEETSUM_STORAGE === "postgres" ? getDatabasePool() : undefined
}

type TemplateRow = {
  id: string
  workspace_id: string
  key: string
  name: string
  description: string | null
  language: string | null
  base_template: string | null
  prompt: string
  sections: SectionSpec[] | null
  created_by_user_id: string | null
  archived_at: string | Date | null
  created_at: string | Date
  updated_at: string | Date
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

function fromRow(row: TemplateRow): CustomTemplateRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    key: row.key,
    name: row.name,
    description: row.description ?? undefined,
    language: row.language ?? undefined,
    baseTemplate: row.base_template ?? undefined,
    prompt: row.prompt,
    sections: row.sections ?? [],
    createdByUserId: row.created_by_user_id ?? undefined,
    archivedAt: row.archived_at ? iso(row.archived_at) : undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505"
}

/* ------------------------------------------------------------- queries */

/** Active (non-archived) template of a workspace by key. */
export async function loadCustomTemplate(
  workspaceId: string,
  key: string,
  deps: TemplateStoreDeps = {}
): Promise<CustomTemplateRecord | undefined> {
  const slug = key.startsWith(CUSTOM_TEMPLATE_PREFIX) ? key.slice(CUSTOM_TEMPLATE_PREFIX.length) : key
  const client = resolveClient(deps)

  if (!client) {
    const found = [...memoryTemplates.values()].find(
      (template) => template.workspaceId === workspaceId && template.key === slug && !template.archivedAt
    )

    return found ? structuredClone(found) : undefined
  }

  const result = await client.query(
    "select * from summary_templates where workspace_id = $1 and key = $2 and archived_at is null",
    [workspaceId, slug]
  )
  const row = result.rows[0] as TemplateRow | undefined

  return row ? fromRow(row) : undefined
}

/** Template of a workspace by id (archived included). */
export async function getCustomTemplate(
  workspaceId: string,
  id: string,
  deps: TemplateStoreDeps = {}
): Promise<CustomTemplateRecord | undefined> {
  const client = resolveClient(deps)

  if (!client) {
    const found = memoryTemplates.get(id)

    return found && found.workspaceId === workspaceId ? structuredClone(found) : undefined
  }

  const result = await client.query("select * from summary_templates where workspace_id = $1 and id = $2", [
    workspaceId,
    id,
  ])
  const row = result.rows[0] as TemplateRow | undefined

  return row ? fromRow(row) : undefined
}

export async function listCustomTemplates(
  workspaceId: string,
  options: { includeArchived?: boolean } = {},
  deps: TemplateStoreDeps = {}
): Promise<CustomTemplateRecord[]> {
  const client = resolveClient(deps)

  if (!client) {
    return [...memoryTemplates.values()]
      .filter((template) => template.workspaceId === workspaceId)
      .filter((template) => options.includeArchived || !template.archivedAt)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((template) => structuredClone(template))
  }

  const result = await client.query(
    `select * from summary_templates where workspace_id = $1${
      options.includeArchived ? "" : " and archived_at is null"
    } order by name asc`,
    [workspaceId]
  )

  return (result.rows as TemplateRow[]).map(fromRow)
}

/**
 * Creates (no `id`) or updates a template after validating it. Throws
 * TemplateValidationError, TemplateKeyConflictError or TemplateNotFoundError.
 */
export async function saveCustomTemplate(
  workspaceId: string,
  input: SaveCustomTemplateInput,
  actor: { userId?: string },
  deps: TemplateStoreDeps = {}
): Promise<CustomTemplateRecord> {
  const parsed = parseTemplateInput(input)

  if (!parsed.ok) throw new TemplateValidationError(parsed.errors)

  const value = parsed.input
  const client = resolveClient(deps)
  const now = new Date().toISOString()

  if (!client) {
    const conflict = [...memoryTemplates.values()].find(
      (template) => template.workspaceId === workspaceId && template.key === value.key && template.id !== input.id
    )

    if (conflict) throw new TemplateKeyConflictError(value.key)

    if (input.id) {
      const existing = memoryTemplates.get(input.id)

      if (!existing || existing.workspaceId !== workspaceId) throw new TemplateNotFoundError(input.id)

      const updated: CustomTemplateRecord = { ...existing, ...value, updatedAt: now }

      memoryTemplates.set(updated.id, structuredClone(updated))
      return updated
    }

    const created: CustomTemplateRecord = {
      id: `tpl_${crypto.randomUUID()}`,
      workspaceId,
      ...value,
      createdByUserId: actor.userId,
      createdAt: now,
      updatedAt: now,
    }

    memoryTemplates.set(created.id, structuredClone(created))
    return created
  }

  const fields = [
    value.key,
    value.name,
    value.description ?? null,
    value.language ?? null,
    value.baseTemplate ?? null,
    value.prompt,
    JSON.stringify(value.sections),
  ]

  try {
    if (input.id) {
      const result = await client.query(
        `update summary_templates
            set key = $3, name = $4, description = $5, language = $6, base_template = $7,
                prompt = $8, sections = $9::jsonb, updated_at = now()
          where workspace_id = $1 and id = $2
          returning *`,
        [workspaceId, input.id, ...fields]
      )
      const row = result.rows[0] as TemplateRow | undefined

      if (!row) throw new TemplateNotFoundError(input.id)
      return fromRow(row)
    }

    const result = await client.query(
      `insert into summary_templates
         (id, workspace_id, key, name, description, language, base_template, prompt, sections, created_by_user_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       returning *`,
      [`tpl_${crypto.randomUUID()}`, workspaceId, ...fields, actor.userId ?? null]
    )

    return fromRow(result.rows[0] as TemplateRow)
  } catch (error) {
    if (isUniqueViolation(error)) throw new TemplateKeyConflictError(value.key)
    throw error
  }
}

/** Archives a template; undefined when it is not in the workspace. */
export async function archiveCustomTemplate(
  workspaceId: string,
  id: string,
  deps: TemplateStoreDeps = {}
): Promise<CustomTemplateRecord | undefined> {
  const client = resolveClient(deps)

  if (!client) {
    const existing = memoryTemplates.get(id)

    if (!existing || existing.workspaceId !== workspaceId) return undefined

    const archived = {
      ...existing,
      archivedAt: existing.archivedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    memoryTemplates.set(id, structuredClone(archived))
    return archived
  }

  const result = await client.query(
    `update summary_templates
        set archived_at = coalesce(archived_at, now()), updated_at = now()
      where workspace_id = $1 and id = $2
      returning *`,
    [workspaceId, id]
  )
  const row = result.rows[0] as TemplateRow | undefined

  return row ? fromRow(row) : undefined
}
