import { describe, expect, it } from "vitest"

import {
  ensureBootstrapWorkspace,
  isBootstrapEmail,
  resolveBootstrapIdentities,
} from "@/lib/workspaces/bootstrap"
import { createInMemoryWorkspaceStore } from "@/lib/workspaces/store"

const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv

type Call = { text: string; values: unknown[] }

function bootstrapDb(options: { hasOwner?: boolean } = {}) {
  const calls: Call[] = []

  return {
    calls,
    db: {
      async query(text: string, values: unknown[] = []) {
        const sql = text.replace(/\s+/g, " ").trim()

        calls.push({ text: sql, values })

        if (sql.startsWith("insert into users")) {
          return { rows: [{ id: `usr_${String(values[1]).split("@")[0]}` }] }
        }
        if (sql.startsWith("select user_id from memberships")) {
          return { rows: options.hasOwner ? [{ user_id: "usr_existing" }] : [] }
        }

        return { rows: [] }
      },
    },
  }
}

describe("bootstrap identities", () => {
  it("owner = env subject, else first allowlisted email", () => {
    expect(
      resolveBootstrapIdentities(
        env({ GOOGLE_WORKSPACE_SUBJECT: "Boss@Example.com", MEETSUM_ALLOWED_EMAILS: "a@example.com,b@example.com" })
      )
    ).toEqual({
      owner: "boss@example.com",
      subject: "boss@example.com",
      emails: ["boss@example.com", "a@example.com", "b@example.com"],
    })
    expect(resolveBootstrapIdentities(env({ MEETSUM_ALLOWED_EMAILS: "a@example.com" })).owner).toBe(
      "a@example.com"
    )
    expect(resolveBootstrapIdentities(env({}))).toEqual({ owner: undefined, subject: undefined, emails: [] })
    expect(isBootstrapEmail("A@example.com", env({ MEETSUM_ALLOWED_EMAILS: "a@example.com" }))).toBe(true)
    expect(isBootstrapEmail("x@example.com", env({ MEETSUM_ALLOWED_EMAILS: "a@example.com" }))).toBe(false)
  })
})

describe("ensureBootstrapWorkspace (postgres)", () => {
  it("is a no-op without a subject or allowlist", async () => {
    const { db, calls } = bootstrapDb()

    expect(await ensureBootstrapWorkspace(db, env({}))).toEqual({ userIds: {} })
    expect(calls).toHaveLength(0)
  })

  it("creates owner + admin memberships, subject, identities, ownership, favorites and key creators", async () => {
    const { db, calls } = bootstrapDb()
    const result = await ensureBootstrapWorkspace(
      db,
      env({ GOOGLE_WORKSPACE_SUBJECT: "boss@example.com", MEETSUM_ALLOWED_EMAILS: "a@example.com" })
    )
    const texts = calls.map((call) => call.text)

    expect(result.ownerUserId).toBe("usr_boss")
    expect(texts.filter((text) => text.startsWith("insert into users"))).toHaveLength(2)
    expect(calls.find((call) => call.text.includes("'owner'") && call.text.startsWith("insert into memberships"))?.values).toEqual([
      "ws_default",
      "usr_boss",
    ])
    expect(
      calls
        .filter((call) => call.text.includes("'admin'") && call.text.includes("do nothing"))
        .map((call) => call.values[1])
    ).toEqual(["usr_boss", "usr_a"])
    expect(texts.some((text) => /google_subject = coalesce\(google_subject, \$2\)/.test(text))).toBe(true)
    expect(texts.some((text) => text.startsWith("update google_identities set workspace_id"))).toBe(true)
    expect(texts.some((text) => /update meetings set owner_user_id = \$2 where workspace_id = \$1 and owner_user_id is null/.test(text))).toBe(true)
    expect(texts.some((text) => /insert into meeting_favorites .* is_favorite = true/.test(text))).toBe(true)
    expect(texts.some((text) => /update api_keys set created_by_user_id = \$2 .* created_by_user_id is null/.test(text))).toBe(true)
  })

  it("never re-assigns ownership when ws_default already has an owner", async () => {
    const { db, calls } = bootstrapDb({ hasOwner: true })

    await ensureBootstrapWorkspace(db, env({ MEETSUM_ALLOWED_EMAILS: "a@example.com" }))

    expect(calls.some((call) => call.text.includes("role = 'owner', updated_at"))).toBe(false)
    expect(calls.some((call) => call.text.includes("google_subject"))).toBe(false)
  })
})

describe("in-memory bootstrap", () => {
  it("is idempotent and never downgrades", async () => {
    const store = createInMemoryWorkspaceStore()
    const bootEnv = env({ GOOGLE_WORKSPACE_SUBJECT: "boss@example.com", MEETSUM_ALLOWED_EMAILS: "a@example.com" })

    await store.ensureBootstrap(bootEnv)
    await store.ensureBootstrap(bootEnv)

    const boss = await store.getUserByEmail("boss@example.com")
    const a = await store.getUserByEmail("a@example.com")

    expect(await store.getMembership("ws_default", boss!.id)).toMatchObject({ role: "owner" })
    expect(await store.getMembership("ws_default", a!.id)).toMatchObject({ role: "admin" })
    expect((await store.getWorkspace("ws_default"))?.googleSubject).toBe("boss@example.com")

    await store.setMemberRole({ workspaceId: "ws_default", userId: a!.id, role: "owner" })
    await store.ensureBootstrap(bootEnv)
    expect(await store.getMembership("ws_default", a!.id)).toMatchObject({ role: "owner" })
    expect((await store.listMembers("ws_default")).length).toBe(2)
  })
})
