import { readFileSync } from "node:fs"

import { describe, expect, it, vi } from "vitest"

import { assertRealizeOSPrivacy, RealizeOSPrivateMeetingError } from "@/lib/integrations/realizeos"

/**
 * M10 R11: RealizeOS export honours the M8 privacy gate. A private meeting
 * leaves only with its current owner's per-meeting opt-in; admins and other
 * members cannot opt it in; shared meetings need no lookup.
 */

const owner = "user_owner"

describe("assertRealizeOSPrivacy", () => {
  it("allows workspace and link meetings without reading prefs", async () => {
    const getPrefs = vi.fn()

    await assertRealizeOSPrivacy({ id: "m1", visibility: "workspace", ownerUserId: owner }, "ws_a", getPrefs)
    await assertRealizeOSPrivacy({ id: "m1", visibility: "link", ownerUserId: owner }, "ws_a", getPrefs)
    expect(getPrefs).not.toHaveBeenCalled()
  })

  it("blocks a private meeting without an opt-in, and one opted in by someone other than the owner", async () => {
    await expect(assertRealizeOSPrivacy({ id: "m1", visibility: "private", ownerUserId: owner }, "ws_a", async () => undefined)).rejects.toBeInstanceOf(
      RealizeOSPrivateMeetingError
    )
    await expect(
      assertRealizeOSPrivacy({ id: "m1", visibility: "private", ownerUserId: owner }, "ws_a", async () => ({
        allowPrivatePush: true,
        allowPrivateSetByUserId: "user_admin",
      }))
    ).rejects.toMatchObject({ code: "private_meeting_not_opted_in", status: 403 })
  })

  it("allows a private meeting the current owner opted in, scoped to its workspace", async () => {
    const getPrefs = vi.fn(async () => ({ allowPrivatePush: true, allowPrivateSetByUserId: owner }))

    await assertRealizeOSPrivacy({ id: "m1", visibility: "private", ownerUserId: owner }, "ws_a", getPrefs)
    expect(getPrefs).toHaveBeenCalledWith("ws_a", "m1")
  })

  it("fails closed for an unknown visibility or a missing owner", async () => {
    const optedIn = async () => ({ allowPrivatePush: true, allowPrivateSetByUserId: owner })

    await expect(assertRealizeOSPrivacy({ id: "m1", ownerUserId: owner }, "ws_a", async () => undefined)).rejects.toBeInstanceOf(
      RealizeOSPrivateMeetingError
    )
    await expect(assertRealizeOSPrivacy({ id: "m1", visibility: "private" }, "ws_a", optedIn)).rejects.toBeInstanceOf(RealizeOSPrivateMeetingError)
  })

  it("is enforced inside exportMeetingToRealizeOS, before the payload is built or sent", () => {
    const code = readFileSync("lib/integrations/realizeos.ts", "utf8")
    const body = code.slice(code.indexOf("export async function exportMeetingToRealizeOS"))

    expect(body.indexOf("assertRealizeOSPrivacy(meeting")).toBeGreaterThan(-1)
    expect(body.indexOf("assertRealizeOSPrivacy(meeting")).toBeLessThan(body.indexOf("createRealizeOSPayload(meeting)"))
    expect(body.indexOf("assertRealizeOSPrivacy(meeting")).toBeLessThan(body.indexOf("await fetch("))
  })
})
