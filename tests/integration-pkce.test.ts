import { describe, expect, it } from "vitest"

import { codeChallengeS256, createCodeVerifier } from "@/lib/integrations/core/pkce"

/** M8 A1: PKCE S256 (RFC 7636 appendix B vector). */
describe("PKCE S256", () => {
  it("matches the RFC 7636 appendix B vector", () => {
    expect(codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    )
  })

  it("creates 43-character base64url verifiers that differ every time", () => {
    const a = createCodeVerifier()
    const b = createCodeVerifier()

    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
  })
})
