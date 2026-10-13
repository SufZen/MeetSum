/**
 * Workspace summary templates in `summary_templates` (owner: Package D).
 * Step 0 stubs that throw "not implemented (M5)".
 */
import type { SectionSpec } from "@/lib/ai/templates/types"

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

function notImplemented(method: string): never {
  throw new Error(`${method}: not implemented (M5)`)
}

export async function loadCustomTemplate(
  workspaceId: string,
  key: string
): Promise<CustomTemplateRecord | undefined> {
  void workspaceId
  void key
  return notImplemented("loadCustomTemplate")
}

export async function listCustomTemplates(
  workspaceId: string,
  options: { includeArchived?: boolean } = {}
): Promise<CustomTemplateRecord[]> {
  void workspaceId
  void options
  return notImplemented("listCustomTemplates")
}

export async function saveCustomTemplate(
  workspaceId: string,
  input: SaveCustomTemplateInput,
  actor: { userId?: string }
): Promise<CustomTemplateRecord> {
  void workspaceId
  void input
  void actor
  return notImplemented("saveCustomTemplate")
}

export async function archiveCustomTemplate(
  workspaceId: string,
  id: string
): Promise<CustomTemplateRecord | undefined> {
  void workspaceId
  void id
  return notImplemented("archiveCustomTemplate")
}
