/**
 * M9 C3 `shouldRedirectToOnboarding` (docs/parity/m9.md): only an
 * owner/admin of a workspace at most 14 days old with no meetings, whose
 * progress is neither dismissed nor completed; off with
 * MEETSUM_ONBOARDING_ENABLED=false; never throws.
 */
import { describe, expect, it } from "vitest"

import { createMemoryOnboardingProgressStore } from "@/lib/onboarding/progress"
import { computeOnboardingRedirect, type OnboardingContext, type OnboardingDeps } from "@/lib/onboarding/service"

const NOW = new Date("2026-10-13T12:00:00Z")

function ctx(role: OnboardingContext["role"], meetings: unknown[] = [], principal: "user" | "api_key" = "user"): OnboardingContext {
  return {
    principal,
    user: principal === "user" ? { id: "u1", email: "u1@x.example" } : undefined,
    role,
    workspace: { id: "ws", name: "W", slug: "w" },
    meetings: { listMeetings: async () => meetings } as unknown as OnboardingContext["meetings"],
  }
}

function deps(extra: Partial<OnboardingDeps> = {}): OnboardingDeps {
  return {
    progress: createMemoryOnboardingProgressStore(),
    workspaceCreatedAt: async () => "2026-10-10T00:00:00Z",
    env: {} as NodeJS.ProcessEnv,
    now: NOW,
    ...extra,
  }
}

describe("computeOnboardingRedirect", () => {
  it("redirects a fresh owner or admin with no meetings", async () => {
    expect(await computeOnboardingRedirect(ctx("owner"), deps())).toBe(true)
    expect(await computeOnboardingRedirect(ctx("admin"), deps())).toBe(true)
  })

  it("never redirects members, viewers or API keys", async () => {
    expect(await computeOnboardingRedirect(ctx("member"), deps())).toBe(false)
    expect(await computeOnboardingRedirect(ctx("viewer"), deps())).toBe(false)
    expect(await computeOnboardingRedirect(ctx("owner", [], "api_key"), deps())).toBe(false)
  })

  it("stops once there is a meeting, the workspace is older than 14 days, or it is disabled", async () => {
    expect(await computeOnboardingRedirect(ctx("owner", [{ id: "m1" }]), deps())).toBe(false)
    expect(await computeOnboardingRedirect(ctx("owner"), deps({ workspaceCreatedAt: async () => "2026-09-28T00:00:00Z" }))).toBe(false)
    expect(
      await computeOnboardingRedirect(ctx("owner"), deps({ env: { MEETSUM_ONBOARDING_ENABLED: "false" } as NodeJS.ProcessEnv }))
    ).toBe(false)
  })

  it("stops after dismiss or complete (no redirect after reload)", async () => {
    for (const action of ["dismiss", "complete"] as const) {
      const progress = createMemoryOnboardingProgressStore()

      await progress.apply("ws", "u1", { action })
      expect(await computeOnboardingRedirect(ctx("owner"), deps({ progress }))).toBe(false)
    }
  })

  it("never throws", async () => {
    const broken = {
      get: async () => Promise.reject(new Error("db down")),
      apply: async () => Promise.reject(new Error("db down")),
    }

    expect(await computeOnboardingRedirect(ctx("owner"), deps({ progress: broken }))).toBe(false)
  })
})
