/**
 * Dev/e2e fake HubSpot endpoints (docs/parity/m8.md, "Fake mode"), served by
 * A's `createFakeProviderServer`. Keys are `"<METHOD> <path>"` with the
 * provider origin stripped. In-memory and fake tokens only.
 */
import type { FakeProviderHandlers, FakeProviderRequest } from "@/lib/integrations/core/types"

let counter = 1000

const nextId = () => String((counter += 1))

function inputs(request: FakeProviderRequest): Array<{ objectWriteTraceId?: string }> {
  const body = request.body as { inputs?: Array<{ objectWriteTraceId?: string }> } | undefined

  return Array.isArray(body?.inputs) ? body.inputs : []
}

export const hubspotFakeHandlers: FakeProviderHandlers = {
  "GET /oauth/authorize": (request) => {
    const target = new URL(request.query.redirect_uri ?? "http://127.0.0.1/")

    target.searchParams.set("code", "fake-hubspot-code")
    target.searchParams.set("state", request.query.state ?? "")
    return { redirect: target.toString() }
  },
  "POST /oauth/v1/token": () => ({
    body: {
      token_type: "bearer",
      expires_in: 1800,
      access_token: `fake-hubspot-access-${Date.now()}`,
      refresh_token: `fake-hubspot-refresh-${Date.now()}`,
    },
  }),
  "POST /crm/v3/objects/contacts/search": (request) => {
    const values =
      (request.body as { filterGroups?: Array<{ filters?: Array<{ values?: string[] }> }> } | undefined)?.filterGroups?.[0]
        ?.filters?.[0]?.values ?? []

    return {
      body: {
        total: values.length,
        results: values.map((email, index) => ({ id: String(500 + index), properties: { email } })),
      },
    }
  },
  "POST /crm/v3/objects/meetings": () => ({ status: 201, body: { id: nextId() } }),
  "POST /crm/v3/objects/notes": () => ({ status: 201, body: { id: nextId() } }),
  "POST /crm/v3/objects/tasks/batch/create": (request) => ({
    status: 201,
    body: {
      status: "COMPLETE",
      results: inputs(request).map((input) => ({ id: nextId(), objectWriteTraceId: input.objectWriteTraceId })),
    },
  }),
  "POST /crm/v3/objects/deals/search": () => ({
    body: {
      results: [
        { id: "9001", properties: { dealname: "עסקת בדיקה", dealstage: "appointmentscheduled" } },
        { id: "9002", properties: { dealname: "Fake deal", dealstage: "qualifiedtobuy" } },
      ],
    },
  }),
  "GET /crm/v3/owners": () => ({ body: { results: [] } }),
  // Token introspection and revoke (tokens in the form body, never the path).
  "POST /oauth/v3/token/introspect": () => ({
    body: { active: true, hub_id: 4242, hub_domain: "fake-portal.hubspot.example", scopes: ["oauth", "crm.objects.contacts.read"] },
  }),
  "POST /oauth/v3/token/revoke": () => ({ status: 204 }),
}

/**
 * Fake routes whose path carries an id (PATCH engagement, association
 * batches). A's fake server is expected to fall back to
 * prefix matching for these keys.
 */
export const hubspotFakePrefixHandlers: FakeProviderHandlers = {
  "PATCH /crm/v3/objects/meetings/": () => ({ body: { id: "patched" } }),
  "PATCH /crm/v3/objects/notes/": () => ({ body: { id: "patched" } }),
  "POST /crm/v4/associations/": () => ({ body: { status: "COMPLETE", results: [] } }),
  "GET /crm/v3/objects/deals/": () => ({ body: { id: "9001", properties: { dealname: "עסקת בדיקה" } } }),
}

Object.assign(hubspotFakeHandlers, hubspotFakePrefixHandlers)
