/**
 * Follow-up email drafts (M5 D5), in Hebrew or English and three tones
 * (formal, friendly, concise). The model writes the subject and prose from
 * the meeting's summary and decisions; the action-item list ("owner — task —
 * due") is assembled from the stored items, never by the model, so it can't
 * invent work. Variants (`he:formal`, …) are cached in
 * `meeting_generated_docs` by input hash. Sending is M8.
 */
import { z } from "zod"

import { generateStructured } from "@/lib/ai/llm"
import { sha1Hex } from "@/lib/intelligence/normalize"
import {
  getGeneratedDoc,
  listGeneratedDocs,
  upsertGeneratedDoc,
} from "@/lib/intelligence/prep/generated-docs"
import {
  actionItemDue,
  actionItemOwner,
  clip,
  formatDueDate,
  meetingActionItems,
  meetingDecisions,
} from "@/lib/intelligence/prep/shared"
import type { MeetingRecord, RepoScope } from "@/lib/meetings/repository"

export const FOLLOW_UP_PROMPT_VERSION = "m5.followup.1"
/** `mailto:` links stay under common client limits. */
export const MAILTO_MAX_BODY_CHARS = 1800

export type FollowUpTone = "formal" | "friendly" | "concise"

export const FOLLOW_UP_TONES: readonly FollowUpTone[] = ["formal", "friendly", "concise"]

export type FollowUpOptions = {
  language: "he" | "en"
  tone: FollowUpTone
  includeActionItems: boolean
  recipients?: string[]
}

export type FollowUpEmail = {
  subject: string
  bodyText: string
}

export type FollowUpVariant = FollowUpEmail & {
  /** e.g. `he:formal` */
  variant: string
  createdAt: string
  includeActionItems?: boolean
  aiRunId?: string
  /** Served from cache (same inputs). */
  cached?: boolean
}

/** The meeting has nothing to follow up on (no summary, decisions or tasks). */
export class FollowUpUnavailableError extends Error {
  constructor() {
    super("Meeting has no summary to follow up on")
    this.name = "FollowUpUnavailableError"
  }
}

export const followUpSchema = z.object({
  subject: z.string(),
  greeting: z.string(),
  body: z.string(),
  closing: z.string(),
})

export type FollowUpOutput = z.infer<typeof followUpSchema>

type FollowUpContent = FollowUpEmail & { includeActionItems: boolean }

export function followUpVariantKey(options: Pick<FollowUpOptions, "language" | "tone">): string {
  return `${options.language}:${options.tone}`
}

/** "owner — task — due" lines from the stored open action items. */
export function actionItemLines(meeting: MeetingRecord, language: "he" | "en"): string[] {
  const unassigned = language === "he" ? "ללא אחראי" : "Unassigned"

  return meetingActionItems(meeting)
    .filter((item) => item.status === "open" && item.title.trim())
    .map((item) => {
      const due = actionItemDue(item)

      return `- ${actionItemOwner(item) ?? unassigned} — ${clip(item.title, 200)}${due ? ` — ${due}` : ""}`
    })
}

const TONE_GUIDE = {
  he: {
    formal: "טון רשמי ומכבד, משפטים מלאים.",
    friendly: "טון חם וידידותי, עדיין מקצועי.",
    concise: "קצר מאוד: עד 4 משפטים בגוף המייל.",
  },
  en: {
    formal: "Formal, courteous tone with full sentences.",
    friendly: "Warm, friendly tone that stays professional.",
    concise: "Very short: at most 4 sentences in the body.",
  },
} as const

export function followUpInstructions(meeting: MeetingRecord, options: FollowUpOptions): string {
  const date = formatDueDate(meeting.startedAt) ?? meeting.startedAt
  const overview = meeting.summary?.overview ?? meeting.intelligence?.overview ?? ""
  const decisions = meetingDecisions(meeting).slice(0, 10).map((decision) => `- ${clip(decision, 300)}`)
  const recipients = options.recipients?.length ? options.recipients.join(", ") : undefined

  if (options.language === "he") {
    return [
      "נסח/י מייל המשך (follow-up) לפגישה, בעברית עסקית טבעית.",
      `הפגישה: ${meeting.title} (${date}).`,
      recipients ? `נמענים: ${recipients}.` : "",
      `סיכום: ${clip(overview, 1500) || "—"}`,
      decisions.length ? ["החלטות:", ...decisions].join("\n") : "",
      "",
      `טון: ${TONE_GUIDE.he[options.tone]}`,
      "החזר/י subject (שורת נושא קצרה), greeting (פתיחה), body (גוף המייל: תודה, סיכום והחלטות) ו-closing (סיום, בלי שם חותם).",
      options.includeActionItems
        ? "רשימת המשימות תצורף אוטומטית אחרי הגוף — אל תפרט/י משימות בעצמך."
        : "אל תפרט/י משימות.",
      "ניסוח ניטרלי מגדרית כשהמגדר לא ידוע (\"תודה לכולם\", \"יש לשלוח\"). אל תמציא/י פרטים. מונחים טכניים נשארים באנגלית. תאריכים בפורמט DD.MM.YYYY.",
    ]
      .filter(Boolean)
      .join("\n")
  }

  return [
    "Write a follow-up email for the meeting.",
    `Meeting: ${meeting.title} (${date}).`,
    recipients ? `Recipients: ${recipients}.` : "",
    `Summary: ${clip(overview, 1500) || "—"}`,
    decisions.length ? ["Decisions:", ...decisions].join("\n") : "",
    "",
    `Tone: ${TONE_GUIDE.en[options.tone]}`,
    "Return subject (short), greeting, body (thanks, recap and decisions) and closing (no signature name).",
    options.includeActionItems
      ? "The action-item list is appended automatically after the body: do not list tasks yourself."
      : "Do not list tasks.",
    "Never invent details.",
  ]
    .filter(Boolean)
    .join("\n")
}

/** greeting + body + action items + closing. */
export function assembleFollowUp(
  output: FollowUpOutput,
  meeting: MeetingRecord,
  options: FollowUpOptions
): FollowUpEmail {
  const lines = options.includeActionItems ? actionItemLines(meeting, options.language) : []
  const heading = options.language === "he" ? "משימות להמשך:" : "Action items:"
  const parts = [
    output.greeting.trim(),
    output.body.trim(),
    lines.length ? [heading, ...lines].join("\n") : "",
    output.closing.trim(),
  ].filter(Boolean)

  return { subject: output.subject.replace(/\s+/g, " ").trim(), bodyText: parts.join("\n\n") }
}

function followUpInputHash(meeting: MeetingRecord, options: FollowUpOptions): string {
  return sha1Hex(
    JSON.stringify({
      v: FOLLOW_UP_PROMPT_VERSION,
      title: meeting.title,
      startedAt: meeting.startedAt,
      overview: meeting.summary?.overview ?? meeting.intelligence?.overview ?? "",
      decisions: meetingDecisions(meeting),
      items: options.includeActionItems ? actionItemLines(meeting, options.language) : [],
      options: { ...options, recipients: [...(options.recipients ?? [])].sort() },
    })
  )
}

function toVariant(
  doc: { variant: string; createdAt: string; aiRunId?: string; content: FollowUpContent },
  cached?: boolean
): FollowUpVariant {
  return {
    subject: doc.content.subject,
    bodyText: doc.content.bodyText,
    includeActionItems: doc.content.includeActionItems,
    variant: doc.variant,
    createdAt: doc.createdAt,
    aiRunId: doc.aiRunId,
    ...(cached ? { cached } : {}),
  }
}

export async function listFollowUpVariants(
  scope: RepoScope,
  meeting: MeetingRecord
): Promise<FollowUpVariant[]> {
  const docs = await listGeneratedDocs<FollowUpContent>(scope, meeting.id, { kind: "follow_up_email" })

  return docs.map((doc) => toVariant(doc))
}

/**
 * Generates a variant, or serves it from cache when the inputs are the same
 * and `force` is not set. Throws FollowUpUnavailableError when the meeting
 * has nothing to follow up on; LLM errors propagate.
 */
export async function generateFollowUpEmail(
  scope: RepoScope,
  meeting: MeetingRecord,
  options: FollowUpOptions & { force?: boolean; actorUserId?: string }
): Promise<FollowUpVariant> {
  const hasContent =
    Boolean(meeting.summary?.overview ?? meeting.intelligence?.overview) ||
    meetingDecisions(meeting).length > 0 ||
    meetingActionItems(meeting).length > 0

  if (!hasContent) throw new FollowUpUnavailableError()

  const { force, actorUserId, ...input } = options
  const variant = followUpVariantKey(input)
  const inputHash = followUpInputHash(meeting, input)
  const cached = await getGeneratedDoc<FollowUpContent>(scope, meeting.id, "follow_up_email", variant)

  if (cached && cached.inputHash === inputHash && !force) return toVariant(cached, true)

  const result = await generateStructured<FollowUpOutput>({
    task: "follow_up",
    ctx: { workspaceId: scope.workspaceId, meetingId: meeting.id, promptVersion: FOLLOW_UP_PROMPT_VERSION },
    language: input.language,
    instructions: followUpInstructions(meeting, input),
    schema: { name: "follow_up_email", zod: followUpSchema },
    effort: "low",
    validate: (value) => (value.subject.trim() ? [] : ["subject must not be empty"]),
  })
  const email = assembleFollowUp(result.value, meeting, input)
  const content: FollowUpContent = { ...email, includeActionItems: input.includeActionItems }
  const saved = await upsertGeneratedDoc<FollowUpContent>(scope, {
    meetingId: meeting.id,
    kind: "follow_up_email",
    variant,
    inputHash,
    content,
    sourceMeetingIds: [meeting.id],
    aiRunId: result.aiRunId,
    createdByUserId: actorUserId,
  })

  return toVariant({
    variant,
    content,
    createdAt: saved?.createdAt ?? new Date().toISOString(),
    aiRunId: result.aiRunId,
  })
}
