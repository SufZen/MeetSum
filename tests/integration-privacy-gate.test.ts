import { describe, expect, it } from "vitest"

import { evaluatePrivacyGate } from "@/lib/integrations/core/privacy"

/**
 * M8 privacy gate (pure part): non-owner rule → skip; owner rule with
 * include_private → allow; owner meeting pref → allow; pref set by a
 * non-owner → skip; manual send by the owner → allow; by an admin → skip.
 * The deliver-time re-check and the inactive-owner case are covered in
 * integration-deliver / integration-dispatcher.
 */

const PRIVATE = { visibility: "private" as const, ownerUserId: "owner" }

describe("evaluatePrivacyGate", () => {
  it("allows shared meetings", () => {
    expect(evaluatePrivacyGate({ facts: { visibility: "workspace", ownerUserId: "owner" }, origin: "rule" }).allowed).toBe(true)
    expect(evaluatePrivacyGate({ facts: { visibility: "link" }, origin: "manual" }).allowed).toBe(true)
  })

  it("skips a private meeting for a rule created by someone else, even with include_private", () => {
    expect(
      evaluatePrivacyGate({ facts: PRIVATE, origin: "rule", rule: { includePrivate: true, createdByUserId: "admin" } })
    ).toEqual({ allowed: false, reason: "private_meeting" })
  })

  it("allows the owner's own include_private rule, but not without the flag", () => {
    expect(evaluatePrivacyGate({ facts: PRIVATE, origin: "rule", rule: { includePrivate: true, createdByUserId: "owner" } })).toEqual({
      allowed: true,
      via: "owner_rule",
    })
    expect(evaluatePrivacyGate({ facts: PRIVATE, origin: "rule", rule: { includePrivate: false, createdByUserId: "owner" } }).allowed).toBe(false)
  })

  it("honours the meeting pref only when the owner set it", () => {
    const rule = { includePrivate: false, createdByUserId: "admin" }

    expect(
      evaluatePrivacyGate({ facts: PRIVATE, origin: "rule", rule, prefs: { allowPrivatePush: true, allowPrivateSetByUserId: "owner" } })
    ).toEqual({ allowed: true, via: "owner_pref" })
    expect(
      evaluatePrivacyGate({ facts: PRIVATE, origin: "rule", rule, prefs: { allowPrivatePush: true, allowPrivateSetByUserId: "admin" } }).allowed
    ).toBe(false)
  })

  it("treats unknown visibility and a missing owner as private", () => {
    expect(evaluatePrivacyGate({ facts: { visibility: undefined, ownerUserId: "owner" }, origin: "rule" }).allowed).toBe(false)
    expect(
      evaluatePrivacyGate({ facts: { visibility: "private" }, origin: "manual", requestedByUserId: undefined, prefs: { allowPrivatePush: true } })
        .allowed
    ).toBe(false)
  })

  it("lets the owner send manually; an admin participant cannot", () => {
    expect(evaluatePrivacyGate({ facts: PRIVATE, origin: "manual", requestedByUserId: "owner" })).toEqual({ allowed: true, via: "owner_manual" })
    expect(evaluatePrivacyGate({ facts: PRIVATE, origin: "manual", requestedByUserId: "admin" }).allowed).toBe(false)
  })
})
