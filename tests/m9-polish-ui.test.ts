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

/** WCAG relative luminance contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((index) => {
      const value = parseInt(hex.slice(index, index + 2), 16) / 255

      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })

    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!
  }
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)

  return (hi! + 0.05) / (lo! + 0.05)
}

describe("offline.html", () => {
  const html = read("public/offline.html")
  const tokens = (block: string) =>
    Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((match) => [match[1]!, match[2]!]))
  const light = tokens(html.slice(html.indexOf(":root {"), html.indexOf("@media")))
  const dark = tokens(html.slice(html.indexOf("@media (prefers-color-scheme: dark)")))

  it.each([
    ["light", light],
    ["dark", dark],
  ])("meets AA contrast in %s mode (text and the Retry button)", (_mode, palette) => {
    expect(contrast(palette.fg!, palette.surface!)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(palette["fg-2"]!, palette.surface!)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(palette["on-brand"]!, palette.brand!)).toBeGreaterThanOrEqual(4.5)
  })

  it("the button uses the on-brand token, not a fixed white", () => {
    expect(html).toContain("color: var(--on-brand)")
  })
})

describe("small polish", () => {
  it("the toaster region has a localized label", () => {
    expect(read("app/[locale]/layout.tsx")).toContain("containerAriaLabel={i18n.dictionary.shellToastRegionLabel}")
  })

  it("Invite member opens Admin → Invitations", () => {
    expect(read("components/command-center-shell.tsx")).toContain(
      'onInvite={() => navigate({ panel: "admin", adminTab: "invitations" })}'
    )
  })

  it("the rename dialog has a Cancel button", () => {
    const source = read("components/meeting-dialogs.tsx")
    const rename = source.slice(source.indexOf("export function RenameMeetingDialog"), source.indexOf("export function", source.indexOf("export function RenameMeetingDialog") + 10))

    expect(rename).toContain("{dictionary.cancel}")
    expect(rename).toContain("onClick={() => onOpenChange(false)}")
  })
})
