/**
 * Notion database properties for a meeting page (docs/parity/m8.md, C1).
 * Owner: Package C. Pure.
 *
 * Any database schema works: `GET /v1/databases/{id}` gives the title
 * property's real name, and the optional properties are set only when they
 * exist with a compatible type (Date → `date`; Participants →
 * `multi_select`/`rich_text`; Language → `select`/`rich_text`; an optional
 * `MeetSum ID` rich_text is located for the create marker, see deliver.ts).
 */
import type { MeetingRecap } from "@/lib/integrations/recap"
import { NOTION_MAX_TEXT_LENGTH, notionRichText } from "@/lib/integrations/notion/blocks"

export type NotionDatabase = {
  id?: string
  title?: { plain_text?: string; text?: { content?: string } }[]
  archived?: boolean
  in_trash?: boolean
  properties?: Record<string, { name?: string; type?: string }>
}

export type NotionPropertyMap = {
  title: string
  date?: string
  participants?: { name: string; type: "multi_select" | "rich_text" }
  language?: { name: string; type: "select" | "rich_text" }
  /**
   * Optional `MeetSum ID` rich_text property. A new page gets the random
   * per-create marker of its pending intent there (set by notion/deliver.ts,
   * never the meeting id), so a retried create can find its own page.
   */
  meetsumId?: string
}

/** Case-insensitive lookup of a conventional property name. */
function findProperty(
  properties: NonNullable<NotionDatabase["properties"]>,
  names: readonly string[]
): [string, { type?: string }] | undefined {
  const wanted = new Set(names.map((name) => name.toLowerCase()))

  return Object.entries(properties).find(([name]) => wanted.has(name.toLowerCase()))
}

export function resolveNotionPropertyMap(database: NotionDatabase, titleOverride?: string): NotionPropertyMap {
  const properties = database.properties ?? {}
  const titles = Object.entries(properties).filter(([, property]) => property.type === "title")
  const title =
    (titleOverride && titles.find(([name]) => name === titleOverride)?.[0]) ?? titles[0]?.[0] ?? "Name"
  const map: NotionPropertyMap = { title }
  const date = findProperty(properties, ["Date", "תאריך"])
  const participants = findProperty(properties, ["Participants", "Attendees", "משתתפים"])
  const language = findProperty(properties, ["Language", "שפה"])
  const meetsumId = findProperty(properties, ["MeetSum ID", "MeetSum Id", "meetsum_id"])

  if (date?.[1].type === "date") map.date = date[0]
  if (participants && (participants[1].type === "multi_select" || participants[1].type === "rich_text")) {
    map.participants = { name: participants[0], type: participants[1].type }
  }
  if (language && (language[1].type === "select" || language[1].type === "rich_text")) {
    map.language = { name: language[0], type: language[1].type }
  }
  if (meetsumId?.[1].type === "rich_text") map.meetsumId = meetsumId[0]

  return map
}

/** Plain-text title of a database (picker label). */
export function notionDatabaseTitle(database: NotionDatabase): string {
  return (database.title ?? [])
    .map((item) => item.plain_text ?? item.text?.content ?? "")
    .join("")
    .trim()
}

/** Select/multi_select option names may not contain commas and are ≤ 100 chars. */
function optionName(value: string): string {
  return value.replace(/,/g, "").replace(/\s+/g, " ").trim().slice(0, 100)
}

export function buildNotionProperties(recap: MeetingRecap, map: NotionPropertyMap): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    [map.title]: { title: notionRichText((recap.title || "MeetSum").slice(0, NOTION_MAX_TEXT_LENGTH * 10)).slice(0, 10) },
  }

  if (map.date) properties[map.date] = { date: { start: recap.startedAt } }

  if (map.participants) {
    const names = recap.participants.map((participant) => participant.name).filter(Boolean)

    properties[map.participants.name] =
      map.participants.type === "multi_select"
        ? {
            multi_select: [...new Set(names.map(optionName).filter(Boolean))]
              .slice(0, 100)
              .map((name) => ({ name })),
          }
        : { rich_text: notionRichText(names.join(", ")).slice(0, 100) }
  }

  if (map.language) {
    properties[map.language.name] =
      map.language.type === "select"
        ? { select: { name: optionName(recap.language) || "unknown" } }
        : { rich_text: notionRichText(recap.language) }
  }

  return properties
}
