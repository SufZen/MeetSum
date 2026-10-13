/**
 * Follow-up email drafts (M5 D5), in Hebrew or English and three tones
 * (formal, friendly, concise). The model writes the subject and prose from
 * the meeting's summary and decisions; the action-item list ("owner — task —
 * due") is assembled from the stored items, never by the model, so it can't
 * invent work. Sending is M8.
 *
 * Cache safety: a variant (`he:formal`, …) is one row shared by everyone who
 * can see the meeting, so its prompt and input hash depend only on
 * meeting-derived data plus the language/tone enums. Nothing the caller
 * types reaches the model or the cache: recipients only build the response's
 * `mailto:`, and the action-item list is applied when the response is
 * assembled, not stored.
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

export const FOLLOW_UP_PROMPT_VERSION = "m5.followup.2"
/** `mailto:` links stay under common client limits. */
export const MAILTO_MAX_BODY_CHARS = 1800
export const MAX_FOLLOW_UP_RECIPIENTS = 20

export type FollowUpTone = "formal" | "friendly" | "concise"

export const FOLLOW_UP_TONES: readonly FollowUpTone[] = ["formal", "friendly", "concise"]

/** What a cached variant may depend on: enums only. */
export type FollowUpVariantKey = {
  language: "he" | "en"
  tone: FollowUpTone
}

/** How a response is assembled from a cached variant (never stored). */
export type FollowUpAssembly = {
  includeActionItems: boolean
}

export type FollowUpOptions = FollowUpVariantKey & FollowUpAssembly

export type FollowUpEmail = {
  subject: string
  bodyText: string
}

export type FollowUpVariant = FollowUpEmail & {
  /** e.g. `he:formal` */
  variant: string
  createdAt: string
  includeActionItems: boolean
  aiRunId?: string
  /** Served from cache (same inputs). */
  cached?: boolean
  /**
   * Generated for this caller only and not saved: callers without
   * `meeting:write` never write the shared cached variant.
   */
  ephemeral?: boolean
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

/** Stored content: the model's parts only. */
type FollowUpContent = FollowUpOutput

export function followUpVariantKey(options: FollowUpVariantKey): string {
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

/** Prompt from meeting data and the language/tone enums only. */
export function followUpInstructions(meeting: MeetingRecord, options: FollowUpVariantKey): string {
  const date = formatDueDate(meeting.startedAt) ?? meeting.startedAt
  const overview = meeting.summary?.overview ?? meeting.intelligence?.overview ?? ""
  const decisions = meetingDecisions(meeting).slice(0, 10).map((decision) => `- ${clip(decision, 300)}`)

  if (options.language === "he") {
    return [
      "נסח/י מייל המשך (follow-up) לפגישה, בעברית עסקית טבעית.",
      `הפגישה: ${meeting.title} (${date}).`,
      `סיכום: ${clip(overview, 1500) || "—"}`,
      decisions.length ? ["החלטות:", ...decisions].join("\n") : "",
      "",
      `טון: ${TONE_GUIDE.he[options.tone]}`,
      "החזר/י subject (שורת נושא קצרה), greeting (פתיחה), body (גוף המייל: תודה, סיכום והחלטות) ו-closing (סיום, בלי שם חותם).",
      "רשימת משימות עשויה להתווסף אוטומטית אחרי הגוף — אל תפרט/י משימות בעצמך.",
      "ניסוח ניטרלי מגדרית כשהמגדר לא ידוע (\"תודה לכולם\", \"יש לשלוח\"). אל תמציא/י פרטים. מונחים טכניים נשארים באנגלית. תאריכים בפורמט DD.MM.YYYY.",
    ]
      .filter(Boolean)
      .join("\n")
  }

  return [
    "Write a follow-up email for the meeting.",
    `Meeting: ${meeting.title} (${date}).`,
    `Summary: ${clip(overview, 1500) || "—"}`,
    decisions.length ? ["Decisions:", ...decisions].join("\n") : "",
    "",
    `Tone: ${TONE_GUIDE.en[options.tone]}`,
    "Return subject (short), greeting, body (thanks, recap and decisions) and closing (no signature name).",
    "An action-item list may be appended automatically after the body: do not list tasks yourself.",
    "Never invent details.",
  ]
    .filter(Boolean)
    .join("\n")
}

/** greeting + body + (action items) + closing. */
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

/** Meeting-derived inputs plus the variant enums; nothing else. */
function followUpInputHash(meeting: MeetingRecord, key: FollowUpVariantKey): string {
  return sha1Hex(
    JSON.stringify({
      v: FOLLOW_UP_PROMPT_VERSION,
      title: meeting.title,
      startedAt: meeting.startedAt,
      overview: meeting.summary?.overview ?? meeting.intelligence?.overview ?? "",
      decisions: meetingDecisions(meeting),
      language: key.language,
      tone: key.tone,
    })
  )
}

function parseVariant(variant: string): FollowUpVariantKey | undefined {
  const [language, tone] = variant.split(":")

  return (language === "he" || language === "en") && FOLLOW_UP_TONES.includes(tone as FollowUpTone)
    ? { language, tone: tone as FollowUpTone }
    : undefined
}

function toVariant(
  meeting: MeetingRecord,
  doc: { variant: string; createdAt: string; aiRunId?: string; content: FollowUpContent },
  assembly: FollowUpAssembly,
  cached?: boolean
): FollowUpVariant | undefined {
  const key = parseVariant(doc.variant)
  const parsed = followUpSchema.safeParse(doc.content)

  // Rows from an older content shape are skipped (regenerated on demand).
  if (!key || !parsed.success) return undefined

  return {
    ...assembleFollowUp(parsed.data, meeting, { ...key, ...assembly }),
    includeActionItems: assembly.includeActionItems,
    variant: doc.variant,
    createdAt: doc.createdAt,
    aiRunId: doc.aiRunId,
    ...(cached ? { cached } : {}),
  }
}

export async function listFollowUpVariants(
  scope: RepoScope,
  meeting: MeetingRecord,
  assembly: FollowUpAssembly = { includeActionItems: true }
): Promise<FollowUpVariant[]> {
  const docs = await listGeneratedDocs<FollowUpContent>(scope, meeting.id, { kind: "follow_up_email" })

  return docs.flatMap((doc) => toVariant(meeting, doc, assembly) ?? [])
}

/**
 * Generates a variant, or serves it from cache when the meeting inputs are
 * unchanged and `force` is not set. `meeting` must have been loaded through
 * the caller's scope, and every docs-store call is scoped by `scope`.
 *
 * Only callers with `meeting:write` (`canWrite`) write or overwrite the
 * shared row; anyone else gets a variant that is returned but not saved
 * (`ephemeral`). Callers must still restrict `force` to `meeting:write`.
 * Throws FollowUpUnavailableError when there is nothing to follow up on; LLM
 * errors propagate.
 */
export async function generateFollowUpEmail(
  scope: RepoScope,
  meeting: MeetingRecord,
  options: FollowUpOptions & { force?: boolean; actorUserId?: string; canWrite: boolean }
): Promise<FollowUpVariant> {
  const hasContent =
    Boolean(meeting.summary?.overview ?? meeting.intelligence?.overview) ||
    meetingDecisions(meeting).length > 0 ||
    meetingActionItems(meeting).length > 0

  if (!hasContent) throw new FollowUpUnavailableError()

  const key: FollowUpVariantKey = { language: options.language, tone: options.tone }
  const assembly: FollowUpAssembly = { includeActionItems: options.includeActionItems }
  const variant = followUpVariantKey(key)
  const inputHash = followUpInputHash(meeting, key)
  const cached = await getGeneratedDoc<FollowUpContent>(scope, meeting.id, "follow_up_email", variant)

  if (cached && cached.inputHash === inputHash && !options.force) {
    const served = toVariant(meeting, cached, assembly, true)

    if (served) return served
  }

  const result = await generateStructured<FollowUpOutput>({
    task: "follow_up",
    ctx: { workspaceId: scope.workspaceId, meetingId: meeting.id, promptVersion: FOLLOW_UP_PROMPT_VERSION },
    language: key.language,
    instructions: followUpInstructions(meeting, key),
    schema: { name: "follow_up_email", zod: followUpSchema },
    effort: "low",
    validate: (value) => (value.subject.trim() ? [] : ["subject must not be empty"]),
  })
  const content: FollowUpContent = {
    subject: result.value.subject,
    greeting: result.value.greeting,
    body: result.value.body,
    closing: result.value.closing,
  }

  if (!options.canWrite) {
    return {
      ...toVariant(
        meeting,
        { variant, content, createdAt: new Date().toISOString(), aiRunId: result.aiRunId },
        assembly
      )!,
      ephemeral: true,
    }
  }

  const saved = await upsertGeneratedDoc<FollowUpContent>(scope, {
    meetingId: meeting.id,
    kind: "follow_up_email",
    variant,
    inputHash,
    content,
    sourceMeetingIds: [meeting.id],
    aiRunId: result.aiRunId,
    createdByUserId: options.actorUserId,
  })

  return toVariant(
    meeting,
    { variant, content, createdAt: saved?.createdAt ?? new Date().toISOString(), aiRunId: result.aiRunId },
    assembly
  )!
}

const EMAIL = /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]{2,}$/

/** Validated recipients (emails, ≤ 20, lowercased, deduplicated) or null. */
export function parseRecipients(value: unknown): string[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_FOLLOW_UP_RECIPIENTS) return null

  const emails: string[] = []

  for (const entry of value) {
    if (typeof entry !== "string" || entry.length > 254) return null

    const email = entry.trim().toLowerCase()

    if (!EMAIL.test(email)) return null
    if (!emails.includes(email)) emails.push(email)
  }

  return emails
}

/** `mailto:` for a variant, or undefined when the body is too long. */
export function buildMailto(variant: FollowUpEmail, recipients: readonly string[]): string | undefined {
  if (variant.bodyText.length > MAILTO_MAX_BODY_CHARS) return undefined

  const to = recipients.map((email) => encodeURIComponent(email)).join(",")

  return `mailto:${to}?subject=${encodeURIComponent(variant.subject)}&body=${encodeURIComponent(variant.bodyText)}`
}
