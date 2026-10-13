/**
 * Data boundaries for prompts. Meeting content (transcript lines, titles,
 * summaries, decisions, task titles) is untrusted: it goes inside a tagged
 * block, and the preamble tells the model that everything inside data tags
 * is data, never instructions. `<` in the data is replaced by `‹` so the
 * text can never close its block (`</transcript>`) or open a fake tag.
 */

/** Tags the preamble declares as data. */
export const DATA_TAGS = ["transcript", "meeting", "related_meetings", "meeting_data", "turns"] as const

export type DataTag = (typeof DATA_TAGS)[number]

/** Replaces `<` with `‹` (U+2039) so data cannot open or close a tag. */
export function neutralizeData(text: string): string {
  return text.replace(/</g, "‹")
}

/** `<tag>\n…\n</tag>` with the content neutralized. */
export function dataBlock(tag: DataTag, content: string): string {
  return `<${tag}>\n${neutralizeData(content)}\n</${tag}>`
}
