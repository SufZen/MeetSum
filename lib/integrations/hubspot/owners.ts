/**
 * Task owner mapping by email (docs/parity/m8.md, B3 step 3):
 * `GET /crm/v3/owners?email=<email>` → `hubspot_owner_id`, cached for one
 * delivery. Needs the optional `crm.objects.owners.read` scope; a 403 turns
 * the lookup off for the rest of the delivery and tasks stay unassigned.
 */
import { ProviderError } from "@/lib/integrations/core/types"
import type { HubspotClient } from "@/lib/integrations/hubspot/client"

type OwnersResponse = { results?: Array<{ id?: string; email?: string | null; archived?: boolean }> }

export type OwnerResolver = (email: string | undefined) => Promise<string | undefined>

export function createOwnerResolver(client: HubspotClient): OwnerResolver {
  const cache = new Map<string, string | undefined>()
  let disabled = false

  return async (raw) => {
    const email = raw?.trim().toLowerCase()

    if (!email || disabled) return undefined
    if (cache.has(email)) return cache.get(email)

    try {
      const response = await client.request<OwnersResponse>(
        "GET",
        `/crm/v3/owners?email=${encodeURIComponent(email)}&limit=1&archived=false`
      )
      const owner = (response.results ?? []).find(
        (candidate) => candidate.id && !candidate.archived && candidate.email?.toLowerCase() === email
      )

      cache.set(email, owner?.id)
      return owner?.id
    } catch (error) {
      if (error instanceof ProviderError && (error.kind === "forbidden" || error.kind === "not_found")) {
        disabled = error.kind === "forbidden"
        cache.set(email, undefined)
        return undefined
      }
      throw error
    }
  }
}
