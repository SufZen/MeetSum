import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { buildNotionProperties, resolveNotionPropertyMap } from "@/lib/integrations/notion/properties"
import type { MeetingRecap } from "@/lib/integrations/recap"

/**
 * M8 C1: only properties that exist in the target database with a
 * compatible type are set; the title is always set, whatever its name.
 */
const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/integrations/notion", name), "utf8"))

const RECAP: MeetingRecap = {
  meetingId: "meet_1",
  title: "סנכרון שבועי",
  language: "he",
  dir: "rtl",
  startedAt: "2026-10-12T07:30:00.000Z",
  participants: [{ name: "דנה" }, { name: "Alex", email: "alex@example.com" }],
  actionItems: [],
  decisions: [],
  openQuestions: [],
  links: {},
  visibility: "workspace",
}

describe("resolveNotionPropertyMap", () => {
  it("finds a custom title property and the compatible optional ones", () => {
    const map = resolveNotionPropertyMap(fixture("database.json"))

    expect(map).toEqual({
      title: "Meeting",
      date: "Date",
      participants: { name: "Participants", type: "multi_select" },
      language: { name: "Language", type: "select" },
    })
  })

  it("skips missing or incompatible optional properties", () => {
    const map = resolveNotionPropertyMap(fixture("database-minimal.json"))

    expect(map).toEqual({ title: "Name" })
  })

  it("honours an explicit title property from the destination", () => {
    expect(resolveNotionPropertyMap(fixture("database.json"), "Meeting").title).toBe("Meeting")
    // An unknown override falls back to the real title property.
    expect(resolveNotionPropertyMap(fixture("database.json"), "Nope").title).toBe("Meeting")
  })
})

describe("buildNotionProperties", () => {
  it("sets the title always and the optional properties by type", () => {
    const properties = buildNotionProperties(RECAP, resolveNotionPropertyMap(fixture("database.json")))

    expect(properties).toEqual({
      Meeting: { title: [{ type: "text", text: { content: "סנכרון שבועי" } }] },
      Date: { date: { start: "2026-10-12T07:30:00.000Z" } },
      Participants: { multi_select: [{ name: "דנה" }, { name: "Alex" }] },
      Language: { select: { name: "he" } },
    })
  })

  it("writes rich_text variants and drops commas that multi_select refuses", () => {
    const properties = buildNotionProperties(
      { ...RECAP, participants: [{ name: "Doe, Jane" }] },
      {
        title: "Name",
        participants: { name: "People", type: "rich_text" },
        language: { name: "Lang", type: "rich_text" },
      }
    )

    expect(properties.People).toEqual({ rich_text: [{ type: "text", text: { content: "Doe, Jane" } }] })
    expect(properties.Lang).toEqual({ rich_text: [{ type: "text", text: { content: "he" } }] })

    const multi = buildNotionProperties(
      { ...RECAP, participants: [{ name: "Doe, Jane" }] },
      { title: "Name", participants: { name: "People", type: "multi_select" } }
    )

    expect(multi.People).toEqual({ multi_select: [{ name: "Doe Jane" }] })
  })

  it("caps the title at 2000 characters", () => {
    const properties = buildNotionProperties({ ...RECAP, title: "א".repeat(5000) }, { title: "Name" })
    const title = (properties.Name as { title: { text: { content: string } }[] }).title

    expect(title.every((item) => item.text.content.length <= 2000)).toBe(true)
  })
})
