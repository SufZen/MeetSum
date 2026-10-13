/**
 * Rules API service (docs/parity/m8.md A3 and "Rules"). Owner: Package A.
 * zod validation; the destination provider must equal the rule provider
 * (and the connection's); caps → 409; `validateDestination` checks the
 * destination with the provider; `include_private` is honoured only for
 * the saving user, and editing another admin's rule resets it and stamps
 * the editor as the new owner. The email rule is a singleton (POST upserts).
 */
import { randomUUID } from "node:crypto"

import { z } from "zod"

import { auditIntegration, type IntegrationAuditActor } from "@/lib/integrations/core/audit"
import { providerCtx } from "@/lib/integrations/core/connections"
import { getProvider } from "@/lib/integrations/core/registry"
import type { IntegrationStore, StoredRule } from "@/lib/integrations/core/store"
import { ProviderError, RULE_TRIGGERS, type IntegrationRuleDTO, type RuleContent, type RuleDestination } from "@/lib/integrations/core/types"
import { DEFAULT_RULE_CONTENT } from "@/lib/integrations/recap"

const id = z.string().trim().min(1).max(200)
const label = z.string().trim().max(200)
const list = z.array(id).max(100)

export const ruleFiltersSchema = z
  .object({
    roomIds: list.optional(),
    tagNames: list.optional(),
    participantDomains: z
      .object({
        mode: z.enum(["any_external", "includes", "excludes"]),
        domains: z.array(z.string().trim().toLowerCase().regex(/^@?[a-z0-9.-]+\.[a-z]{2,}$/)).max(100),
      })
      .strict()
      .optional(),
    visibility: z.array(z.enum(["private", "workspace", "link"])).max(3).optional(),
    languages: z.array(z.string().trim().regex(/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/)).max(20).optional(),
    sources: list.optional(),
    minDurationMinutes: z.number().int().min(0).max(24 * 60).optional(),
  })
  .strict()

export const ruleContentSchema = z
  .object({
    overview: z.boolean(),
    actionItems: z.boolean(),
    decisions: z.boolean(),
    openQuestions: z.boolean(),
    transcript: z.boolean(),
    link: z.enum(["app", "existing_share", "none"]),
  })
  .strict()

export const ruleDestinationSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("slack"), channelId: z.string().trim().regex(/^[A-Z0-9]{2,32}$/i), channelName: label }).strict(),
  z
    .object({
      provider: z.literal("notion"),
      databaseId: z.string().trim().regex(/^[A-Za-z0-9-]{8,64}$/),
      databaseTitle: label,
      titleProperty: label.optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("hubspot"),
      dealId: z.string().trim().regex(/^\d{1,30}$/).optional(),
      dealName: label.optional(),
      logAs: z.enum(["meeting", "note"]),
      createTasks: z.boolean(),
      createMissingContacts: z.boolean(),
      matchInternal: z.boolean(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("email"),
      audience: z.enum(["members", "attendees"]),
      mode: z.enum(["all_meetings", "opt_in"]),
      locale: z.enum(["meeting", "he", "en"]),
    })
    .strict(),
])

export const createRuleSchema = z
  .object({
    provider: z.enum(["slack", "notion", "hubspot", "email"]),
    connectionId: id.nullable().optional(),
    name: z.string().trim().min(1).max(120),
    enabled: z.boolean().optional(),
    trigger: z.enum(RULE_TRIGGERS),
    filters: ruleFiltersSchema.optional(),
    destination: ruleDestinationSchema,
    content: ruleContentSchema.partial().optional(),
    includePrivate: z.boolean().optional(),
  })
  .strict()

export const updateRuleSchema = createRuleSchema.omit({ provider: true, connectionId: true }).partial().strict()

export type RuleServiceError = { ok: false; status: number; code: string; providerCode?: string; issues?: string[] }
export type RuleServiceResult = { ok: true; rule: IntegrationRuleDTO } | RuleServiceError

export function toRuleDTO(rule: StoredRule): IntegrationRuleDTO {
  const { workspaceId: _ws, ...dto } = rule

  void _ws
  return dto
}

function mergeContent(partial: Partial<RuleContent> | undefined, base: RuleContent = DEFAULT_RULE_CONTENT): RuleContent {
  return { ...base, ...(partial ?? {}) }
}

function invalid(error: z.ZodError): RuleServiceError {
  return { ok: false, status: 400, code: "invalid_rule", issues: error.issues.slice(0, 10).map((issue) => issue.path.join(".") || issue.code) }
}

async function checkDestination(
  store: IntegrationStore,
  workspaceId: string,
  connectionId: string,
  destination: RuleDestination
): Promise<RuleServiceError | undefined> {
  const connection = await store.getConnection(workspaceId, connectionId)

  if (!connection || connection.status !== "active" || connection.provider !== destination.provider) {
    return { ok: false, status: 404, code: "connection_not_found" }
  }

  const provider = getProvider(connection.provider)

  if (!provider?.validateDestination) return undefined

  try {
    await provider.validateDestination(destination, providerCtx(connection, store))
    return undefined
  } catch (error) {
    if (error instanceof ProviderError && error.kind === "auth") return { ok: false, status: 409, code: "integration_needs_reauth" }

    const providerCode = error instanceof ProviderError && /^[a-z_]{1,64}$/.test(error.providerCode ?? "") ? error.providerCode : undefined

    return { ok: false, status: 400, code: "invalid_destination", ...(providerCode ? { providerCode } : {}) }
  }
}

export async function createRule(
  store: IntegrationStore,
  input: {
    workspaceId: string
    userId: string | undefined
    /** Only a signed-in user may opt their own private meetings in (never an API key). */
    isUserPrincipal: boolean
    actor: IntegrationAuditActor
    body: unknown
  }
): Promise<RuleServiceResult> {
  const parsed = createRuleSchema.safeParse(input.body)

  if (!parsed.success) return invalid(parsed.error)

  const body = parsed.data

  if (body.destination.provider !== body.provider) return { ok: false, status: 400, code: "destination_provider_mismatch" }
  if (body.provider === "email") {
    if (body.connectionId) return { ok: false, status: 400, code: "email_rule_has_no_connection" }
    if (body.trigger !== "meeting.completed") return { ok: false, status: 400, code: "email_rule_trigger" }
  } else {
    if (!body.connectionId) return { ok: false, status: 400, code: "connection_required" }

    const failure = await checkDestination(store, input.workspaceId, body.connectionId, body.destination)

    if (failure) return failure
  }

  const result = await store.createRule({
    id: `intr_${randomUUID()}`,
    workspaceId: input.workspaceId,
    provider: body.provider,
    connectionId: body.provider === "email" ? null : (body.connectionId ?? null),
    name: body.name,
    enabled: body.enabled ?? true,
    trigger: body.trigger,
    filters: body.filters ?? {},
    destination: body.destination,
    content: mergeContent(body.content),
    // Honoured only for meetings the saving user owns (privacy gate).
    includePrivate: Boolean(body.includePrivate && input.userId && input.isUserPrincipal),
    ...(input.userId ? { createdByUserId: input.userId } : {}),
  })

  if (!result.ok) {
    return result.reason === "cap"
      ? { ok: false, status: 409, code: "cap_reached" }
      : { ok: false, status: 404, code: "connection_not_found" }
  }

  await auditIntegration(input.actor, "integration.rule.created", { type: "integration_rule", id: result.rule.id }, {
    provider: result.rule.provider,
    trigger: result.rule.trigger,
    ruleId: result.rule.id,
  })

  return { ok: true, rule: toRuleDTO(result.rule) }
}

export async function updateRule(
  store: IntegrationStore,
  input: {
    workspaceId: string
    ruleId: string
    userId: string | undefined
    isUserPrincipal: boolean
    actor: IntegrationAuditActor
    body: unknown
  }
): Promise<RuleServiceResult> {
  const existing = await store.getRule(input.workspaceId, input.ruleId)

  if (!existing) return { ok: false, status: 404, code: "not_found" }

  const parsed = updateRuleSchema.safeParse(input.body)

  if (!parsed.success) return invalid(parsed.error)

  const body = parsed.data

  if (body.destination && body.destination.provider !== existing.provider) {
    return { ok: false, status: 400, code: "destination_provider_mismatch" }
  }
  if (existing.provider === "email" && body.trigger && body.trigger !== "meeting.completed") {
    return { ok: false, status: 400, code: "email_rule_trigger" }
  }
  if (body.destination && existing.connectionId) {
    const failure = await checkDestination(store, input.workspaceId, existing.connectionId, body.destination)

    if (failure) return failure
  }
  if (body.enabled && existing.connectionId) {
    const connection = await store.getConnection(input.workspaceId, existing.connectionId)

    if (!connection || connection.status === "revoked") return { ok: false, status: 409, code: "connection_revoked" }
  }

  const editorChanged = !input.userId || existing.createdByUserId !== input.userId
  const updated = await store.updateRule(input.workspaceId, input.ruleId, {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled, ...(body.enabled ? { disabledReason: null } : {}) } : {}),
    ...(body.trigger !== undefined ? { trigger: body.trigger } : {}),
    ...(body.filters !== undefined ? { filters: body.filters } : {}),
    ...(body.destination !== undefined ? { destination: body.destination } : {}),
    ...(body.content !== undefined ? { content: mergeContent(body.content, existing.content) } : {}),
    // Anyone else's edit (or an API key's) clears the private opt-in and makes
    // the editor the owner: an opt-in can never be set or kept on another
    // person's behalf. The owner re-enables it with their own edit.
    ...(editorChanged
      ? { includePrivate: false, ...(input.userId ? { createdByUserId: input.userId } : {}) }
      : body.includePrivate !== undefined
        ? { includePrivate: body.includePrivate && input.isUserPrincipal }
        : {}),
  })

  if (!updated) return { ok: false, status: 404, code: "not_found" }

  await auditIntegration(input.actor, "integration.rule.updated", { type: "integration_rule", id: updated.id }, {
    provider: updated.provider,
    ruleId: updated.id,
    fields: Object.keys(body),
  })

  return { ok: true, rule: toRuleDTO(updated) }
}

export async function deleteRule(
  store: IntegrationStore,
  input: { workspaceId: string; ruleId: string; actor: IntegrationAuditActor }
): Promise<boolean> {
  const existing = await store.getRule(input.workspaceId, input.ruleId)

  if (!existing || !(await store.deleteRule(input.workspaceId, input.ruleId))) return false

  await auditIntegration(input.actor, "integration.rule.deleted", { type: "integration_rule", id: input.ruleId }, {
    provider: existing.provider,
    ruleId: input.ruleId,
  })
  return true
}
