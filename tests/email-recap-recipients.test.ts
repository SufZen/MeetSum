import { describe, expect, it } from "vitest"

import { resolveRecapRecipients } from "@/lib/integrations/email-recap/recipients"
import type { MeetingRecord } from "@/lib/meetings/repository"

/**
 * M8 A10 recipients: members-only default with `canViewMeeting`, the
 * attendees toggle, private → members only, bot and unsubscribed excluded,
 * the recipient cap.
 */

function participant(email: string | undefined, index: number) {
  return {
    id: `p${index}`,
    meetingId: "m1",
    name: email ?? `Speaker ${index}`,
    ...(email ? { email } : {}),
    role: "attendee" as const,
    source: "calendar" as const,
    attendanceStatus: "accepted" as const,
    createdAt: "",
    updatedAt: "",
  }
}

function meeting(emails: (string | undefined)[], overrides: Partial<MeetingRecord> = {}) {
  return {
    workspaceId: "ws_a",
    ownerUserId: "u_owner",
    visibility: "workspace" as const,
    participantDetails: emails.map(participant),
    ...overrides,
  }
}

const MEMBERS = [
  { userId: "u_owner", email: "owner@acme.test" },
  { userId: "u_dana", email: "dana@acme.test" },
  { userId: "u_avi", email: "Avi@Acme.test" },
]

const base = { members: MEMBERS, unsubscribed: new Set<string>(), botEmail: "bot@acme.test", max: 50 }

describe("resolveRecapRecipients", () => {
  it("defaults to members only, lowercased and de-duplicated", () => {
    const result = resolveRecapRecipients({
      ...base,
      audience: "members",
      meeting: meeting(["DANA@acme.test", "dana@acme.test", "client@customer.com", undefined, "not-an-email", "avi@acme.test"]),
    })

    expect(result.recipients).toEqual([
      { email: "dana@acme.test", isMember: true, userId: "u_dana" },
      { email: "avi@acme.test", isMember: true, userId: "u_avi" },
    ])
    expect(result.excluded.notMember).toBe(1)
  })

  it("includes non-members with the attendees toggle", () => {
    const result = resolveRecapRecipients({ ...base, audience: "attendees", meeting: meeting(["dana@acme.test", "client@customer.com"]) })

    expect(result.recipients.map((recipient) => [recipient.email, recipient.isMember])).toEqual([
      ["dana@acme.test", true],
      ["client@customer.com", false],
    ])
  })

  it("falls back to members for private meetings and keeps only members who can view it", () => {
    const result = resolveRecapRecipients({
      ...base,
      audience: "attendees",
      meeting: meeting(["dana@acme.test", "client@customer.com"], { visibility: "private" }),
    })

    // Dana is a participant (by email), so she can view the private meeting; the client is dropped.
    expect(result.recipients.map((recipient) => recipient.email)).toEqual(["dana@acme.test"])
    expect(result.excluded.notMember).toBe(1)

    // A member who is not a participant cannot view a private meeting: the
    // only way in is participation, so canViewMeeting is applied per member.
    const hidden = resolveRecapRecipients({
      ...base,
      audience: "members",
      meeting: { workspaceId: "ws_a", ownerUserId: "u_owner", visibility: "private", participantDetails: [participant("avi@acme.test", 1)] },
      members: [{ userId: "u_avi", email: "avi@acme.test" }],
    })

    expect(hidden.recipients).toHaveLength(1)
  })

  it("excludes the bot account and unsubscribed addresses", () => {
    const result = resolveRecapRecipients({
      ...base,
      unsubscribed: new Set(["avi@acme.test"]),
      audience: "attendees",
      meeting: meeting(["bot@acme.test", "Avi@acme.test", "dana@acme.test"]),
    })

    expect(result.recipients.map((recipient) => recipient.email)).toEqual(["dana@acme.test"])
    expect(result.excluded).toMatchObject({ bot: 1, unsubscribed: 1 })
  })

  it("caps the number of recipients", () => {
    const emails = Array.from({ length: 60 }, (_, index) => `guest${index}@customer.com`)
    const result = resolveRecapRecipients({ ...base, max: 50, audience: "attendees", meeting: meeting(emails) })

    expect(result.recipients).toHaveLength(50)
    expect(result.excluded.overCap).toBe(10)
  })
})
