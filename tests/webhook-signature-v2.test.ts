import { describe, expect, it } from "vitest"

import {
  computeWebhookSignatureV2,
  signWebhookPayloadV2,
  verifyWebhookSignatureV2,
  WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
} from "@/lib/platform/events"

/**
 * M8 C4: `x-meetsum-signature-v2: t=<unix>,v1=<hex HMAC-SHA256(secret,
 * t + "." + rawBody)>`. The timestamp is signed, so a captured delivery
 * cannot be replayed outside the 5-minute window.
 */
const SECRET = "whsec_test_secret_1234"
const BODY = JSON.stringify({ id: "evt_1", name: "clip.created", version: 2 })
const T = 1_760_000_000

describe("webhook signature v2", () => {
  it("matches the documented vector", () => {
    // HMAC-SHA256("whsec_test_secret_1234", "1760000000." + BODY), also in docs/webhooks/verifying-signatures.md.
    expect(computeWebhookSignatureV2(BODY, SECRET, T)).toBe(
      "0e55d105497846c2677e19306f1917ee1eb519bb12214d54507ab2f2a79fbbaa"
    )
    expect(signWebhookPayloadV2(BODY, SECRET, T).header).toBe(
      "t=1760000000,v1=0e55d105497846c2677e19306f1917ee1eb519bb12214d54507ab2f2a79fbbaa"
    )
  })

  it("verifies within the window and rejects skew both ways", () => {
    const { header } = signWebhookPayloadV2(BODY, SECRET, T)

    expect(verifyWebhookSignatureV2(header, BODY, SECRET, { now: T + 10 })).toEqual({ ok: true, timestamp: T })
    expect(
      verifyWebhookSignatureV2(header, BODY, SECRET, { now: T + WEBHOOK_SIGNATURE_TOLERANCE_SECONDS + 1 })
    ).toEqual({ ok: false, reason: "skew" })
    expect(
      verifyWebhookSignatureV2(header, BODY, SECRET, { now: T - WEBHOOK_SIGNATURE_TOLERANCE_SECONDS - 1 })
    ).toEqual({ ok: false, reason: "skew" })
  })

  it("rejects a replay with a fresh timestamp but the old signature", () => {
    const { header } = signWebhookPayloadV2(BODY, SECRET, T)
    const replayed = header.replace(`t=${T}`, `t=${T + 600}`)

    expect(verifyWebhookSignatureV2(replayed, BODY, SECRET, { now: T + 600 })).toEqual({
      ok: false,
      reason: "mismatch",
    })
  })

  it("rejects a tampered body, a wrong secret and malformed headers", () => {
    const { header } = signWebhookPayloadV2(BODY, SECRET, T)

    expect(verifyWebhookSignatureV2(header, `${BODY} `, SECRET, { now: T })).toMatchObject({ reason: "mismatch" })
    expect(verifyWebhookSignatureV2(header, BODY, "whsec_other", { now: T })).toMatchObject({ reason: "mismatch" })
    for (const bad of [undefined, "", "v1=abc", `t=${T}`, "t=x,v1=00", `t=${T},v1=zz`]) {
      expect(verifyWebhookSignatureV2(bad, BODY, SECRET, { now: T }), String(bad)).toMatchObject({ reason: "malformed" })
    }
  })

  it("accepts any matching v1 entry (secret rotation)", () => {
    const good = computeWebhookSignatureV2(BODY, SECRET, T)
    const header = `t=${T},v1=${"0".repeat(64)},v1=${good}`

    expect(verifyWebhookSignatureV2(header, BODY, SECRET, { now: T })).toEqual({ ok: true, timestamp: T })
  })
})
