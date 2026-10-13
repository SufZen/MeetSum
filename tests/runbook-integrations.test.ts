import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { listProviders } from "@/lib/integrations/core/registry"
import { PROVIDER_IDS } from "@/lib/integrations/core/types"

const runbook = readFileSync(path.join(process.cwd(), "docs", "runbooks", "integrations.md"), "utf8")

/** docs/parity/m8.md "External apps checklist": scopes the runbook must name even before the providers land. */
const SPEC_SCOPES = [
  "chat:write",
  "chat:write.public",
  "channels:read",
  "groups:read",
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Calendars.Read",
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.deals.read",
  "crm.objects.owners.read",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/gmail.send",
]

const SPEC_ENV = [
  "MEETSUM_OAUTH_REDIRECT_BASE",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SCOPES",
  "SLACK_PRIVATE_CHANNELS",
  "SLACK_SIGNING_SECRET",
  "MS_CLIENT_ID",
  "MS_CLIENT_SECRET",
  "MS_TENANT",
  "MS_ALLOWED_TENANTS",
  "NOTION_CLIENT_ID",
  "NOTION_CLIENT_SECRET",
  "HUBSPOT_CLIENT_ID",
  "HUBSPOT_CLIENT_SECRET",
  "HUBSPOT_OPTIONAL_SCOPES",
  "MEETSUM_GOOGLE_DOCS_DWD",
  "MEETSUM_INTEGRATIONS_FAKE_BASE_URL",
  "GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY",
]

const mentions = (token: string) => runbook.includes(`\`${token}\``)

describe("docs/runbooks/integrations.md", () => {
  it("lists every OAuth callback path", () => {
    for (const provider of PROVIDER_IDS) {
      expect(runbook, provider).toContain(`/api/integrations/${provider}/oauth/callback`)
    }
  })

  it("lists every scope and optional scope the registry requests", () => {
    for (const provider of listProviders()) {
      for (const scope of [...(provider.oauth?.scopes ?? []), ...(provider.oauth?.optionalScopes ?? [])]) {
        expect(mentions(scope), `${provider.id}: ${scope}`).toBe(true)
      }
    }
  })

  it("lists the spec's scopes and env vars", () => {
    for (const scope of SPEC_SCOPES) expect(mentions(scope), scope).toBe(true)
    for (const name of SPEC_ENV) expect(runbook, name).toContain(name)
  })

  it("has no unfilled skeleton sections", () => {
    const sections = runbook.split(/^#{2,3} /m).slice(1)

    for (const section of sections) {
      const [heading, ...body] = section.split("\n")

      expect(body.join("\n").trim().length, heading).toBeGreaterThan(0)
    }
  })
})
