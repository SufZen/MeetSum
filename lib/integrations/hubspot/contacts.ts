/**
 * HubSpot contact matching by attendee email (docs/parity/m8.md, B3 step 1).
 * `POST /crm/v3/objects/contacts/search` with an `IN` filter, ≤ 100 emails
 * per request, sequentially. Missing contacts are created only when the
 * destination asks for it (default off).
 */
import { emailDomain } from "@/lib/bot/rules"
import { ProviderError } from "@/lib/integrations/core/types"
import type { HubspotClient } from "@/lib/integrations/hubspot/client"

export const CONTACT_SEARCH_BATCH = 100

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/

/** Lowercased, de-duplicated, valid attendee emails; internal domains dropped unless `matchInternal`. */
export function crmCandidateEmails(
  emails: readonly (string | undefined)[],
  options: { internalDomains: readonly string[]; matchInternal: boolean; exclude?: readonly string[] }
): string[] {
  const internal = new Set(options.internalDomains.map((domain) => domain.toLowerCase()))
  const exclude = new Set((options.exclude ?? []).map((email) => email.toLowerCase()))
  const result: string[] = []

  for (const raw of emails) {
    const email = raw?.trim().toLowerCase()

    if (!email || !EMAIL.test(email) || exclude.has(email) || result.includes(email)) continue
    if (!options.matchInternal && internal.has(emailDomain(email) ?? "")) continue
    result.push(email)
  }

  return result
}

type SearchResponse = { results?: Array<{ id: string; properties?: { email?: string | null } }> }
type CreateResponse = { id?: string }

/** email → contact id for every match (and, optionally, every created contact). */
export async function matchContacts(
  client: HubspotClient,
  emails: readonly string[],
  options: { createMissing: boolean }
): Promise<Map<string, string>> {
  const found = new Map<string, string>()

  for (let index = 0; index < emails.length; index += CONTACT_SEARCH_BATCH) {
    const batch = emails.slice(index, index + CONTACT_SEARCH_BATCH)
    const response = await client.request<SearchResponse>("POST", "/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "IN", values: batch }] }],
      properties: ["email"],
      limit: CONTACT_SEARCH_BATCH,
    })

    for (const contact of response.results ?? []) {
      const email = contact.properties?.email?.trim().toLowerCase()

      if (email && batch.includes(email) && !found.has(email)) found.set(email, contact.id)
    }
  }

  if (!options.createMissing) return found

  for (const email of emails) {
    if (found.has(email)) continue
    try {
      const created = await client.request<CreateResponse>("POST", "/crm/v3/objects/contacts", { properties: { email } })

      if (created?.id) found.set(email, created.id)
    } catch (error) {
      // 409: created concurrently (or search index lag); matched on the next send.
      if (!(error instanceof ProviderError && error.kind === "invalid")) throw error
    }
  }

  return found
}
