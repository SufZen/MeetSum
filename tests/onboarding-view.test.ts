/**
 * M9 C3 onboarding views (docs/parity/m9.md): the wizard renders the stepper
 * with directional chevrons, plural-imperative Hebrew copy, unavailable
 * steps for members; the checklist card hides once dismissed, completed,
 * disabled or done; glossary saves keep only workspace terms.
 */
import { createElement } from "react"
import { describe, expect, it } from "vitest"

import { shouldShowChecklist } from "@/components/onboarding/onboarding-checklist-card"
import { workspaceTerms } from "@/components/onboarding/onboarding-step-panels"
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard"
import { m9OnboardingMessages } from "@/lib/i18n/m9/onboarding"
import type { OnboardingState } from "@/lib/onboarding/types"

import { renderWithI18n } from "./helpers/render-i18n"

const OPEN: OnboardingState = {
  steps: [
    { id: "google", status: "done" },
    { id: "invite", status: "todo" },
    { id: "glossary", status: "skipped" },
    { id: "upload", status: "todo" },
  ],
  dismissed: false,
  completed: false,
}

function render(state: OnboardingState, locale: "he" | "en" = "he") {
  return renderWithI18n(createElement(OnboardingWizard, { locale, initial: state, glossarySuggestions: ["מע״מ"] }), locale)
}

describe("OnboardingWizard", () => {
  it("opens on the first open step with a stepper, progress and directional chevrons", () => {
    const html = render(OPEN)

    expect(html).toContain("מתחילים עם MeetSum")
    expect(html).toContain("1 מתוך 4 שלבים הושלמו")
    expect(html).toContain('aria-current="step"')
    expect(html).toContain("שלב 2 מתוך 4")
    expect(html).toContain("שליחת הזמנה")
    expect(html.match(/data-icon="directional"/g)?.length).toBe(2)
    expect(html).toContain("דילוג")
  })

  it("shows admin-only steps as unavailable", () => {
    const html = render(
      {
        ...OPEN,
        steps: [
          { id: "google", status: "done" },
          { id: "invite", status: "unavailable", reason: "admin_only" },
          { id: "glossary", status: "unavailable", reason: "admin_only" },
          { id: "upload", status: "done" },
        ],
      },
      "en"
    )

    expect(html).toContain("Available to workspace admins")
  })

  it("uses plural imperatives in Hebrew hints", () => {
    expect(m9OnboardingMessages.he.onboardingStepInviteHint).toMatch(/^הזמינו/)
    expect(m9OnboardingMessages.he.onboardingStepUploadHint).toMatch(/^העלו/)
    expect(Object.values(m9OnboardingMessages.he).join(" ")).not.toMatch(/(^|\s)(לחץ|בחר|הזן|תעלה|העלה)(\s|$)/)
  })
})

describe("shouldShowChecklist", () => {
  it("hides when dismissed, completed, disabled or nothing is left", () => {
    expect(shouldShowChecklist(OPEN)).toBe(true)
    expect(shouldShowChecklist({ ...OPEN, dismissed: true })).toBe(false)
    expect(shouldShowChecklist({ ...OPEN, completed: true })).toBe(false)
    expect(shouldShowChecklist({ ...OPEN, enabled: false })).toBe(false)
    expect(
      shouldShowChecklist({ ...OPEN, steps: OPEN.steps.map((step) => ({ ...step, status: "done" as const })) })
    ).toBe(false)
    expect(shouldShowChecklist(null)).toBe(false)
  })
})

describe("workspaceTerms", () => {
  it("drops unchanged built-in defaults and keeps workspace and overridden terms", () => {
    const builtIn = { term: "מע״מ", aliases: [], hotword: true }
    const override = { term: "Lisboa", aliases: ["ליסבון"], hotword: true }

    expect(
      workspaceTerms({
        glossary: { terms: [builtIn, override, { term: "MeetSum", aliases: [], hotword: true }] },
        defaults: { terms: [builtIn, { term: "Lisboa", aliases: [], hotword: true }] },
      }).map((term) => term.term)
    ).toEqual(["Lisboa", "MeetSum"])
  })
})
