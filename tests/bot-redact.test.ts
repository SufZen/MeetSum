import { describe, expect, it } from "vitest"

import { BOT_REDACT_MAX_LENGTH, redactBotError, scrubSecrets } from "@/lib/bot/redact"

describe("redactBotError", () => {
  it.each([
    ["Zoom pwd", "join https://acme.zoom.us/j/81234567890?pwd=AbC123xyz failed", "AbC123xyz"],
    ["Teams p=", "https://teams.live.com/meet/9384756123456?p=Qw12zz rejected", "Qw12zz"],
    ["Teams context", "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%22Tid%22%3a%22tenant-1%22%7d", "tenant-1"],
    ["Meet authuser", "https://meet.google.com/abc-defg-hij?authuser=dana%40acme.co", "dana"],
    ["presigned", "GET https://s3.example/vexa/rec.webm?X-Amz-Credential=AKIAXYZ&X-Amz-Signature=deadbeef01 403", "AKIAXYZ"],
    ["fragment", "https://zoom.us/j/81234567890#pwd=Secret77", "Secret77"],
    ["scheme-less", "zoom.us/j/81234567890?pwd=NoScheme9", "NoScheme9"],
    ["bare pwd", "invalid pwd=Plain123 for meeting", "Plain123"],
    ["bare p", "teams numeric meeting p=Tq99 rejected", "Tq99"],
    ["JSON passcode", '{"detail":"bad","passcode":"5551234"}', "5551234"],
    ["JSON password", '{"password": "hunter two"}', "hunter two"],
    ["JSON pwd", "{'pwd': 'zzTop1'}", "zzTop1"],
    ["JSON meeting_password", '{"meeting_password":"mp-0001"}', "mp-0001"],
    ["passcode label", "passcode: 998877 not accepted", "998877"],
    ["X-API-Key", "X-API-Key: vexa_live_key_0123456789", "vexa_live_key_0123456789"],
    ["api_key json", '{"api_key":"k-123456"}', "k-123456"],
    ["Bearer", "Authorization: Bearer abc.def.ghi", "abc.def.ghi"],
    ["Bearer alone", "sent Bearer tok_ABC123 to gateway", "tok_ABC123"],
    ["webhook secret", '{"webhook_url":"http://x/y","webhook_secret":"whsec_998877"}', "whsec_998877"],
    ["signature header", "X-Webhook-Signature: sha256=0f0e0d0c0b0a", "0f0e0d0c0b0a"],
    ["token", "token=eyJhbGciOiJIUzI1NiJ9 expired", "eyJhbGciOiJIUzI1NiJ9"],
    ["hex blob", `digest ${"ab12".repeat(16)} mismatch`, "ab12ab12ab12ab12"],
    ["base64 blob", `body ${"QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3ODk".repeat(2)}`, "QUJDREVGR0hJSktM"],
  ])("strips %s", (_label, input, secret) => {
    const output = redactBotError(input)

    expect(output).not.toContain(secret)
  })

  it("keeps scheme, host and path of URLs", () => {
    expect(redactBotError("open https://acme.zoom.us/j/81234567890?pwd=x now")).toBe(
      "open https://acme.zoom.us/j/81234567890?[redacted] now"
    )
  })

  it("redacts errors and objects", () => {
    expect(redactBotError(new Error("passcode=1234 bad"))).toBe("passcode=[redacted] bad")
    expect(redactBotError({ passcode: "777", status: 422 })).toBe('{"passcode":"[redacted]","status":422}')
    expect(redactBotError(undefined)).toBe("")
  })

  it("does not mangle ordinary words and short ids", () => {
    const text = "bot.dispatch failed for bot_0123abcd: capacity reached (403) on google_meet abc-defg-hij"

    expect(redactBotError(text)).toBe(text)
  })

  it("caps the output at 300 characters", () => {
    const output = redactBotError("x ".repeat(1000), 10_000)

    expect(output.length).toBeLessThanOrEqual(BOT_REDACT_MAX_LENGTH)
    expect(BOT_REDACT_MAX_LENGTH).toBe(300)
    expect(redactBotError("abcdefghij", 5)).toBe("abcd…")
  })

  it.each([
    ["a. runs", "a.".repeat(25_000)],
    ["slashes", "a/".repeat(25_000)],
    ["hex then letter", `${"a".repeat(50_000)}g`],
    ["scheme-ish", "abc:/".repeat(10_000)],
    ["keys", "passcode=".repeat(6_000)],
  ])("is linear on pathological input (%s)", (_label, input) => {
    const started = performance.now()

    redactBotError(input)
    expect(performance.now() - started).toBeLessThan(50)
  })

  it("scrubSecrets removes literal values", () => {
    expect(scrubSecrets("key k_0123456789abcdef echoed", ["k_0123456789abcdef"])).toBe("key [redacted] echoed")
  })
})
