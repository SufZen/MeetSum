/**
 * M9 A3: every stable snake_case error code returned by an API route has
 * localized he and en text, and the Hebrew UI never shows server English.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { apiErrorCode, apiErrorKey, apiErrorMessage, apiErrorText } from "@/lib/i18n/api-errors"
import { getDictionary } from "@/lib/i18n/dictionaries"
import { translate } from "@/lib/i18n/messages"

/** Codes that only exist in test doubles or as generic placeholders. */
const IGNORED = new Set(["error", "custom", "failed", "fake_server_error", "fake_route_not_found"])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)

    if (statSync(path).isDirectory()) return walk(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

function codesIn(roots: string[]): Set<string> {
  const codes = new Set<string>()
  const pattern = /\b(?:error|code):\s*"([a-z][a-z0-9]*(?:_[a-z0-9]+)*)"/g

  for (const file of roots.flatMap(walk)) {
    for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
      if (!IGNORED.has(match[1]!)) codes.add(match[1]!)
    }
  }

  // Code unions that reach clients as `{ error: code }`.
  for (const file of ["lib/workspaces/store.ts", "lib/bot/api-types.ts"]) {
    for (const match of readFileSync(file, "utf8").matchAll(/^\s*\| "([a-z_]+)"$/gm)) codes.add(match[1]!)
  }
  codes.add("user_required")
  codes.add("rate_limited")

  return codes
}

describe("API error codes", () => {
  const codes = codesIn(["app/api", "lib"])

  it("finds the route codes", () => {
    expect(codes.size).toBeGreaterThan(20)
    expect(codes).toContain("not_found")
    expect(codes).toContain("google_not_configured")
  })

  it("has he and en text for every code", () => {
    const he = getDictionary("he") as Record<string, string>
    const en = getDictionary("en") as Record<string, string>
    const missing = [...codes].filter((code) => !he[apiErrorKey(code)] || !en[apiErrorKey(code)])

    expect(missing).toEqual([])
  })

  it("maps codes to keys", () => {
    expect(apiErrorKey("not_found")).toBe("apiErrNotFound")
    expect(apiErrorKey("google_docs_not_connected")).toBe("apiErrGoogleDocsNotConnected")
    expect(apiErrorCode({ error: "rate_limited" })).toBe("rate_limited")
    expect(apiErrorCode({ error: "Meeting not found" })).toBeUndefined()
    expect(apiErrorCode(null)).toBeUndefined()
  })
})

describe("apiErrorMessage", () => {
  const he = getDictionary("he")
  const en = getDictionary("en")

  it("localizes known codes", () => {
    expect(apiErrorMessage({ error: "google_not_configured", message: "Google OAuth missing" }, he, "x")).toBe(
      he.apiErrGoogleNotConfigured
    )
    expect(apiErrorMessage({ error: "not_found" }, en, "x")).toBe(en.apiErrNotFound)
  })

  it("never shows server English in Hebrew", () => {
    expect(apiErrorMessage({ error: "Meeting not found" }, he, "נכשל")).toBe("נכשל")
    expect(apiErrorMessage({ error: "brand_new_code", message: "Boom" }, he, "נכשל")).toBe(
      translate(he, "coreUnknownErrorCode", { code: "brand_new_code" })
    )
  })

  it("keeps the server message in English when no code matches", () => {
    expect(apiErrorMessage({ error: "Meeting not found" }, en, "Failed")).toBe("Meeting not found")
    expect(apiErrorMessage({ message: "Detailed reason", error: "Bad" }, en, "Failed")).toBe("Detailed reason")
    expect(apiErrorMessage(undefined, en, "Failed")).toBe("Failed")
  })

  it("works with useI18n's t", () => {
    const t = (key: string, values?: Record<string, string | number | undefined>) => translate(he, key, values)

    expect(apiErrorText({ error: "conflict" }, t, "x", "he")).toBe(he.apiErrConflict)
    expect(apiErrorText({ error: "Plain English" }, t, "נכשל", "he")).toBe("נכשל")
  })
})
