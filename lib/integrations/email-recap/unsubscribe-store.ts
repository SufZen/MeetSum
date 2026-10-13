/**
 * Records an email-recap unsubscribe (docs/parity/m8.md A10). Owner:
 * Package A. Audits `email.unsubscribed` with the sha256 of the address,
 * never the address.
 */
import { createHash } from "node:crypto"

import { auditIntegration } from "@/lib/integrations/core/audit"
import { getIntegrationStore, type IntegrationStore, type UnsubscribeSource } from "@/lib/integrations/core/store"
import type { UnsubscribePayload } from "@/lib/integrations/email-recap/unsubscribe-token"

export function addressHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex")
}

export async function recordRecapUnsubscribe(
  payload: UnsubscribePayload,
  source: UnsubscribeSource,
  store?: IntegrationStore
): Promise<void> {
  const db = store ?? (await getIntegrationStore())

  await db.addUnsubscribe(payload.ws, payload.e, source)
  await auditIntegration({ workspaceId: payload.ws, actor: "public:unsubscribe" }, "email.unsubscribed", { type: "email_recap" }, {
    addressHash: addressHash(payload.e),
    source,
  })
}
