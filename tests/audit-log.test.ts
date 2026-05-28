import { describe, expect, it } from "vitest"

import type { AuditAction } from "@/lib/audit"

describe("audit log types", () => {
  it("defines all expected core action categories", () => {
    // Type-level check — if these don't compile, actions are missing
    const coreActions: AuditAction[] = [
      "meeting.created",
      "meeting.processed",
      "meeting.reprocessed",
      "meeting.deleted",
      "meeting.share.created",
      "meeting.share.updated",
      "meeting.share.revoked",
      "meeting.share.accessed",
      "meeting.export.markdown",
      "meeting.export.pdf",
      "room.created",
      "room.meeting.added",
    ]

    expect(coreActions.length).toBeGreaterThanOrEqual(12)
  })

  it("defines integration audit actions", () => {
    const integrationActions: AuditAction[] = [
      "webhook.subscription.created",
      "webhook.subscription.updated",
      "webhook.delivery.retried",
      "webhook.test.sent",
      "realizeos.export.queued",
      "realizeos.export.sent",
      "realizeos.export.failed",
      "realizeos.export.retried",
    ]

    expect(integrationActions.length).toBeGreaterThanOrEqual(8)
  })

  it("defines admin and auth audit actions", () => {
    const adminActions: AuditAction[] = [
      "auth.session.created",
      "auth.session.refreshed",
      "admin.settings.updated",
    ]

    expect(adminActions.length).toBe(3)
  })
})
