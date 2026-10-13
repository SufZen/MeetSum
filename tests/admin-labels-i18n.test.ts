/**
 * M9 follow-up: webhook event descriptions and audit-log action names are
 * localized (no English descriptions or raw ids in the Hebrew UI).
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { dictionaries } from "@/lib/i18n/dictionaries"
import { auditActionKey, webhookEventDescriptionKey } from "@/lib/i18n/label-keys"
import { WEBHOOK_EVENTS_V2 } from "@/lib/platform/event-catalog"
import { webhookEventDescription } from "@/lib/platform/event-schemas"

const auditSource = readFileSync(path.resolve(__dirname, "../components/admin/audit-log-section.tsx"), "utf8")
const auditActions = [...auditSource.slice(auditSource.indexOf("ACTION_OPTIONS = ["), auditSource.indexOf("] as const")).matchAll(/"([a-z_.]+)"/g)].map(
  (match) => match[1]
)

describe("admin label keys", () => {
  it("derives keys from ids", () => {
    expect(auditActionKey("meeting.share.created")).toBe("auditActionMeetingShareCreated")
    expect(auditActionKey("api_key.revoked")).toBe("auditActionApiKeyRevoked")
    expect(webhookEventDescriptionKey("integration.delivery.failed")).toBe("webhookEventDescIntegrationDeliveryFailed")
  })

  it("every webhook event has a Hebrew description and the English one matches the catalog", () => {
    expect(WEBHOOK_EVENTS_V2).toHaveLength(10)
    for (const name of WEBHOOK_EVENTS_V2) {
      const key = webhookEventDescriptionKey(name) as keyof typeof dictionaries.he

      expect(dictionaries.he[key], name).toMatch(/[֐-׿]/)
      expect(dictionaries.en[key], name).toBe(webhookEventDescription(name))
    }
  })

  it("every audit-log filter action has he and en names", () => {
    expect(auditActions.length).toBeGreaterThan(20)
    for (const action of auditActions) {
      const key = auditActionKey(action) as keyof typeof dictionaries.he

      expect(dictionaries.he[key], action).toMatch(/[֐-׿]/)
      expect(dictionaries.en[key], action).toBeTruthy()
    }
  })
})
