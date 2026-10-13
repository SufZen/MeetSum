/**
 * M9 follow-up: small UI fixes from the browser e2e pass (source-level and
 * pure-function checks; the Playwright spec covers the rendered pages).
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { bcp47Lang } from "@/components/notifications/notification-item"

const read = (file: string) => readFileSync(path.resolve(__dirname, "..", file), "utf8")

describe("unavailable deep-linked meeting", () => {
  it("shows the notice inside the reading column, never as a full-width grid row", () => {
    const shell = read("components/command-center-shell.tsx")

    expect(shell).toContain("withUnavailableNotice(")
    expect(shell).not.toMatch(/col-span-full[^"]*bg-warn-soft/)
  })
})

describe("notification bell a11y", () => {
  it("names the popover dialog by its heading", () => {
    const bell = read("components/notifications/notification-bell.tsx")

    expect(bell).toMatch(/<PopoverContent[^>]*aria-labelledby=\{titleId\}/)
    expect(bell).toMatch(/<h2 id=\{titleId\}/)
  })

  it("never sets lang=\"mixed\" on a notification part", () => {
    expect(bcp47Lang("mixed")).toBeUndefined()
    expect(bcp47Lang("unknown")).toBeUndefined()
    expect(bcp47Lang(null)).toBeUndefined()
    expect(bcp47Lang("he")).toBe("he")
    expect(bcp47Lang("en-US")).toBe("en-US")
    expect(read("components/notifications/notification-item.tsx")).toContain('<bdi key={index} dir="auto"')
  })
})
