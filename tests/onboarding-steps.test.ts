/**
 * M9 C3 onboarding steps (docs/parity/m9.md): live detection from facts,
 * role gating (invite and glossary are admin-only), skips, and the stored
 * progress on PGlite (skip set semantics, unskip, dismiss, complete).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createMemoryOnboardingProgressStore, createPostgresOnboardingProgressStore, parseOnboardingAction } from "@/lib/onboarding/progress"
import { loadOnboardingFacts, type OnboardingContext } from "@/lib/onboarding/service"
import { computeOnboardingState, type OnboardingFacts } from "@/lib/onboarding/steps"

import { W1, createM9Database, seedM9Workspaces, type PgLike } from "./helpers/pglite-m9"

const NONE: OnboardingFacts = { googleConnected: false, memberCount: 1, pendingInvitations: 0, glossaryTerms: 0, hasMeetings: false }

describe("computeOnboardingState", () => {
  it("starts with every step open for an owner", () => {
    expect(computeOnboardingState(NONE, "owner", null)).toEqual({
      steps: [
        { id: "google", status: "todo" },
        { id: "invite", status: "todo" },
        { id: "glossary", status: "todo" },
        { id: "upload", status: "todo" },
      ],
      dismissed: false,
      completed: false,
    })
  })

  it("detects each step from live facts", () => {
    const facts: OnboardingFacts = { googleConnected: true, memberCount: 1, pendingInvitations: 1, glossaryTerms: 2, hasMeetings: true }

    expect(computeOnboardingState(facts, "admin", null).steps.map((step) => step.status)).toEqual([
      "done",
      "done",
      "done",
      "done",
    ])
    expect(computeOnboardingState({ ...NONE, memberCount: 2 }, "admin", null).steps[1]?.status).toBe("done")
  })

  it("marks admin-only steps unavailable for members and viewers", () => {
    for (const role of ["member", "viewer"] as const) {
      expect(computeOnboardingState(NONE, role, null).steps).toEqual([
        { id: "google", status: "todo" },
        { id: "invite", status: "unavailable", reason: "admin_only" },
        { id: "glossary", status: "unavailable", reason: "admin_only" },
        { id: "upload", status: "todo" },
      ])
    }
  })

  it("applies skips only to steps that are not done, and reports dismissal and completion", () => {
    const state = computeOnboardingState({ ...NONE, hasMeetings: true }, "owner", {
      skipped: ["google", "upload"],
      dismissedAt: "2026-10-01T00:00:00Z",
      completedAt: null,
    })

    expect(state.steps.map((step) => step.status)).toEqual(["skipped", "todo", "todo", "done"])
    expect(state).toMatchObject({ dismissed: true, completed: false })
  })
})

describe("loadOnboardingFacts", () => {
  const base = (role: OnboardingContext["role"], meetings: unknown[] = []): OnboardingContext => ({
    principal: "user",
    user: { id: "u1", email: "u1@x.example" },
    role,
    workspace: { id: "ws", name: "W", slug: "w" },
    meetings: { listMeetings: async () => meetings } as unknown as OnboardingContext["meetings"],
  })

  it("reads admin facts only for admins and never throws on a failing source", async () => {
    let memberCalls = 0
    const deps = {
      googleConnected: async () => Promise.reject(new Error("google down")),
      countMembers: async () => {
        memberCalls += 1
        return { members: 3, pendingInvitations: 0 }
      },
      countGlossaryTerms: async () => 4,
    }

    expect(await loadOnboardingFacts(base("owner", [{ id: "m" }]), deps)).toEqual({
      googleConnected: false,
      memberCount: 3,
      pendingInvitations: 0,
      glossaryTerms: 4,
      hasMeetings: true,
    })
    expect(await loadOnboardingFacts(base("member"), deps)).toMatchObject({ memberCount: 0, glossaryTerms: 0 })
    expect(memberCalls).toBe(1)
  })

  it("treats a workspace Google subject as connected", async () => {
    const ctx = { ...base("owner"), workspace: { id: "ws", name: "W", slug: "w", googleSubject: "admin@x.example" } }

    expect((await loadOnboardingFacts(ctx, { countMembers: async () => ({ members: 1, pendingInvitations: 0 }), countGlossaryTerms: async () => 0 })).googleConnected).toBe(true)
  })
})

describe("parseOnboardingAction", () => {
  it("accepts the four actions and rejects anything else", () => {
    expect(parseOnboardingAction({ action: "skip", step: "glossary" })).toEqual({ action: "skip", step: "glossary" })
    expect(parseOnboardingAction({ action: "dismiss" })).toEqual({ action: "dismiss" })
    expect(parseOnboardingAction({ action: "skip", step: "everything" })).toBeUndefined()
    expect(parseOnboardingAction({ action: "delete" })).toBeUndefined()
    expect(parseOnboardingAction("skip")).toBeUndefined()
  })
})

let db: PgLike | undefined

beforeAll(async () => {
  db = await createM9Database()
  if (db) await seedM9Workspaces(db)
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe("onboarding progress stores", () => {
  it("memory and Postgres keep skips as a set and stamp dismiss/complete once", async (context) => {
    const stores = [createMemoryOnboardingProgressStore(), ...(db ? [createPostgresOnboardingProgressStore(db)] : [])]

    if (!db) context.skip("PGlite did not load")

    for (const store of stores) {
      expect(await store.get(W1, "usr_owner")).toBeNull()

      await store.apply(W1, "usr_owner", { action: "skip", step: "google" })
      await store.apply(W1, "usr_owner", { action: "skip", step: "google" })
      await store.apply(W1, "usr_owner", { action: "skip", step: "glossary" })
      await store.apply(W1, "usr_owner", { action: "unskip", step: "google" })

      const dismissed = await store.apply(W1, "usr_owner", { action: "dismiss" })
      const again = await store.apply(W1, "usr_owner", { action: "dismiss" })

      expect(dismissed.skipped).toEqual(["glossary"])
      expect(again.dismissedAt).toBe(dismissed.dismissedAt)
      expect(dismissed.completedAt).toBeNull()
      expect((await store.apply(W1, "usr_owner", { action: "complete" })).completedAt).not.toBeNull()
      // Per user: another member's progress is separate.
      expect(await store.get(W1, "usr_admin")).toBeNull()
    }
  })
})
