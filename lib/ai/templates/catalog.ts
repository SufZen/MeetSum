/**
 * Template catalog for the API and UI (M5 D6): built-ins from Package A's
 * registry plus the workspace's custom templates, one list with a `builtIn`
 * flag. Also validates a `templateKey` a meeting or a run may use.
 */
import { listTemplates } from "@/lib/ai/templates/registry"
import {
  customTemplateKey,
  listCustomTemplates,
  loadCustomTemplate,
  type CustomTemplateRecord,
} from "@/lib/ai/templates/store"
import {
  AUTO_TEMPLATE_KEY,
  CUSTOM_TEMPLATE_PREFIX,
  isBuiltInTemplateKey,
  type LocalizedText,
  type SectionSpec,
} from "@/lib/ai/templates/types"

export type TemplateListItem = {
  /** Built-in key or `custom:<key>`. */
  key: string
  builtIn: boolean
  /** Custom templates only. */
  id?: string
  name: LocalizedText
  description: LocalizedText
  language?: string
  baseTemplate?: string
  sections: SectionSpec[]
  archived?: boolean
}

function customItem(template: CustomTemplateRecord): TemplateListItem {
  const description = template.description ?? ""

  return {
    key: customTemplateKey(template.key),
    builtIn: false,
    id: template.id,
    name: { he: template.name, en: template.name },
    description: { he: description, en: description },
    language: template.language,
    baseTemplate: template.baseTemplate,
    sections: template.sections,
    archived: Boolean(template.archivedAt),
  }
}

export async function listTemplateCatalog(
  workspaceId: string,
  options: { includeArchived?: boolean } = {}
): Promise<{ templates: TemplateListItem[]; custom: CustomTemplateRecord[] }> {
  const [registry, custom] = await Promise.all([
    listTemplates(workspaceId),
    listCustomTemplates(workspaceId, options),
  ])
  const builtIns: TemplateListItem[] = registry
    .filter((template) => template.builtIn)
    .map((template) => ({
      key: template.key,
      builtIn: true,
      name: template.name,
      description: template.description,
      language: template.language,
      sections: template.sections,
    }))

  return { templates: [...builtIns, ...custom.map(customItem)], custom }
}

/**
 * True when a meeting/run may use `key`: `auto`, a built-in, or an active
 * `custom:<key>` of the workspace.
 */
export async function isUsableTemplateKey(workspaceId: string, key: string): Promise<boolean> {
  if (key === AUTO_TEMPLATE_KEY || isBuiltInTemplateKey(key)) return true
  if (!key.startsWith(CUSTOM_TEMPLATE_PREFIX)) return false

  return Boolean(await loadCustomTemplate(workspaceId, key))
}
