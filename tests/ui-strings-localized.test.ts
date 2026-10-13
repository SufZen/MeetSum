import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { getDictionary } from "@/lib/i18n/dictionaries"
import { clipsMessagesHe } from "@/lib/i18n/m5/clips"
import { formatMessage } from "@/lib/i18n/workspace-messages"

/** Strings the e2e found untranslated on the Hebrew UI. */
describe("localized meeting UI strings", () => {
  it("has Hebrew values for record, share, add to room, play source and participant counts", () => {
    const he = getDictionary("he")
    const en = getDictionary("en")

    expect(he.recordOnComputer).toBe("הקלטה במחשב הזה")
    expect(he.meetingShare).toBe("שיתוף")
    expect(he.addToRoom).toBe("הוספה לחדר")
    expect(he.playSourceAt).toBe("ניגון המקור מ־")
    expect(clipsMessagesHe.clipsPlaySourceAt).toBe("ניגון המקור מ־")
    expect(formatMessage(he.participantCountOther, { count: 2 })).toBe("2 משתתפים")
    expect(formatMessage(en.participantCountOther, { count: 2 })).toBe("2 participants")
    expect(formatMessage(en.participantCountOne, { count: 1 })).toBe("1 participant")
  })

  it("no longer hard-codes those English strings in the components", () => {
    const files = {
      "components/media-ingestion-drawer.tsx": ['"Record on this computer"'],
      "components/meeting-header.tsx": ["            Share\n", "              Add to room\n"],
      "components/meeting-inbox-panel.tsx": ['"participant" : "participants"'],
    }

    for (const [file, needles] of Object.entries(files)) {
      const source = readFileSync(file, "utf8").replace(/\r\n/g, "\n")

      for (const needle of needles) expect(source, `${file}: ${needle}`).not.toContain(needle)
    }
    expect(readFileSync("components/transcript-timeline.tsx", "utf8")).toContain("playLabel={t.clipsPlaySourceAt}")
  })
})
