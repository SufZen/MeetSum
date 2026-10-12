import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth/server", () => ({ getCurrentSession: vi.fn() }))

import { getAllowedEmails } from "@/lib/auth/session"
import { allowedExplicitSubject } from "@/lib/google/request-subject"

const env = { GOOGLE_WORKSPACE_SUBJECT: "admin@example.test" } as unknown as NodeJS.ProcessEnv

describe("allowedExplicitSubject", () => {
  it("lets a session user name their own mailbox or the configured subject", () => {
    expect(allowedExplicitSubject("User@Example.test", "user@example.test", env)).toBe(
      "user@example.test"
    )
    expect(allowedExplicitSubject("admin@example.test", "user@example.test", env)).toBe(
      "admin@example.test"
    )
  })

  it("drops a subject belonging to someone else", () => {
    expect(allowedExplicitSubject("ceo@example.test", "user@example.test", env)).toBeUndefined()
  })

  it("ignores blank input", () => {
    expect(allowedExplicitSubject("  ", "user@example.test", env)).toBeUndefined()
    expect(allowedExplicitSubject(null, "user@example.test", env)).toBeUndefined()
  })
})

describe("getAllowedEmails", () => {
  it("treats a blank allowlist as unset and falls back to the workspace subject", () => {
    expect(
      getAllowedEmails({
        MEETSUM_ALLOWED_EMAILS: " ",
        GOOGLE_WORKSPACE_SUBJECT: "admin@example.test",
      } as unknown as NodeJS.ProcessEnv)
    ).toEqual(["admin@example.test"])
  })
})
