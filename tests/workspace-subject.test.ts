import { describe, expect, it } from "vitest"

import { getAllowedEmails, parseAllowedEmails } from "@/lib/auth/session"
import {
  WorkspaceSubjectNotConfiguredError,
  getConfiguredWorkspaceSubject,
  resolveWorkspaceSubject,
} from "@/lib/google/workspace-subject"

const env = (values: Record<string, string>) =>
  ({ NODE_ENV: "test", ...values }) as NodeJS.ProcessEnv

describe("resolveWorkspaceSubject", () => {
  it("prefers an explicit subject over env and session", () => {
    expect(
      resolveWorkspaceSubject({
        explicit: "Explicit@Example.com ",
        sessionEmail: "session@example.com",
        env: env({ GOOGLE_WORKSPACE_SUBJECT: "env@example.com" }),
      })
    ).toBe("explicit@example.com")
  })

  it("falls back to GOOGLE_WORKSPACE_SUBJECT before the session email", () => {
    expect(
      resolveWorkspaceSubject({
        sessionEmail: "session@example.com",
        env: env({ GOOGLE_WORKSPACE_SUBJECT: "env@example.com" }),
      })
    ).toBe("env@example.com")
  })

  it("accepts the legacy GOOGLE_WORKSPACE_ADMIN_EMAIL alias", () => {
    expect(
      getConfiguredWorkspaceSubject(
        env({ GOOGLE_WORKSPACE_ADMIN_EMAIL: "admin@example.com" })
      )
    ).toBe("admin@example.com")
  })

  it("uses the signed-in session email when nothing is configured", () => {
    expect(
      resolveWorkspaceSubject({
        explicit: "  ",
        sessionEmail: "Session@Example.com",
        env: env({}),
      })
    ).toBe("session@example.com")
  })

  it("throws a configuration error instead of using a baked-in identity", () => {
    expect(() => resolveWorkspaceSubject({ env: env({}) })).toThrow(
      WorkspaceSubjectNotConfiguredError
    )
    expect(() => resolveWorkspaceSubject({ env: env({}) })).toThrow(
      /GOOGLE_WORKSPACE_SUBJECT/
    )
  })
})

describe("allowed sign-in emails", () => {
  it("has no default allow-list", () => {
    expect(parseAllowedEmails(undefined)).toEqual([])
    expect(getAllowedEmails(env({}))).toEqual([])
  })

  it("uses MEETSUM_ALLOWED_EMAILS, else bootstraps from the Workspace subject", () => {
    expect(
      getAllowedEmails(
        env({
          MEETSUM_ALLOWED_EMAILS: "A@example.com, b@example.com",
          GOOGLE_WORKSPACE_SUBJECT: "env@example.com",
        })
      )
    ).toEqual(["a@example.com", "b@example.com"])
    expect(
      getAllowedEmails(env({ GOOGLE_WORKSPACE_SUBJECT: "Env@example.com" }))
    ).toEqual(["env@example.com"])
  })
})
