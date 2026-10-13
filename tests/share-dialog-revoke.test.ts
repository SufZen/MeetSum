/**
 * M9 follow-up: revoking a share link asks first, and afterwards the dialog
 * shows a revoked state with "Create a new link" (not a stuck "Creating…").
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { shareLinkFieldState } from "@/components/share/share-meeting-dialog"
import { dictionaries } from "@/lib/i18n/dictionaries"

const source = readFileSync(path.resolve(__dirname, "../components/share/share-meeting-dialog.tsx"), "utf8")

describe("share dialog revoke", () => {
  it("shows the revoked state after a revoke, creating only before the first link", () => {
    expect(shareLinkFieldState({ shareLink: "", revoked: false })).toBe("creating")
    expect(shareLinkFieldState({ shareLink: "", revoked: true })).toBe("revoked")
    expect(shareLinkFieldState({ shareLink: "https://x/share/t", revoked: true })).toBe("ready")
  })

  it("the Revoke button opens a confirm dialog instead of revoking at once", () => {
    expect(source).toContain("onClick={() => setRevokeConfirmOpen(true)}")
    expect(source).toMatch(/<ConfirmDialog[\s\S]*onConfirm=\{\(\) => revokeShareLink\(\)\}/)
    expect(source).not.toContain("onClick={() => void revokeShareLink()}")
  })

  it("has he and en copy for the confirm and the revoked state", () => {
    for (const key of [
      "shareDialogRevokeConfirmTitle",
      "shareDialogRevokeConfirmDescription",
      "shareDialogRevokedState",
      "shareDialogCreateNew",
    ] as const) {
      expect(dictionaries.he[key]).toMatch(/[֐-׿]/)
      expect(dictionaries.en[key]).toBeTruthy()
    }
  })
})
