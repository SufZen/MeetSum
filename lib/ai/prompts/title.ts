/**
 * Title / tags / meeting-type instructions (A5), in the output language.
 */
import { neutralizeData } from "@/lib/ai/prompts/data-block"
import { MEETING_TYPES } from "@/lib/ai/templates/builtins"
import { MAX_TOPICS, MEETING_TAG_VALUES, TITLE_MAX_CHARS } from "@/lib/ai/templates/schema"

export type TitlePromptInput = {
  language: string
  currentTitle: string
  participants: string[]
}

export function buildTitleInstructions(input: TitlePromptInput): string {
  const types = MEETING_TYPES.join(", ")
  const tags = MEETING_TAG_VALUES.join(", ")

  if (input.language === "he") {
    return [
      `הכותרת הנוכחית: ${neutralizeData(input.currentTitle)}`,
      input.participants.length ? `משתתפים: ${input.participants.map(neutralizeData).join(", ")}` : "",
      "יש להחזיר:",
      `- title: כותרת תיאורית קצרה בעברית (עד ${TITLE_MAX_CHARS} תווים), בלי מירכאות ובלי תאריך.`,
      `- meetingType: אחד מ: ${types}.`,
      `- topics: עד ${MAX_TOPICS} נושאים קצרים בעברית.`,
      `- tags: תגיות מתוך: ${tags}.`,
    ]
      .filter(Boolean)
      .join("\n")
  }

  return [
    `Current title: ${neutralizeData(input.currentTitle)}`,
    input.participants.length ? `Participants: ${input.participants.map(neutralizeData).join(", ")}` : "",
    "Return:",
    `- title: a short descriptive title in the output language (at most ${TITLE_MAX_CHARS} characters), no quotes, no date.`,
    `- meetingType: one of ${types}.`,
    `- topics: up to ${MAX_TOPICS} short topics in the output language.`,
    `- tags: tags from ${tags}.`,
  ]
    .filter(Boolean)
    .join("\n")
}
