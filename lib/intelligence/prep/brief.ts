/**
 * Prep brief (M5 D4): what to know before a meeting, from related meetings
 * the user can see (same participants, room or topic) and their open action
 * items. The model only sees aliases (`M1`, `T3`); every claim must cite a
 * related meeting and unknown aliases are dropped, so nothing in the brief
 * points at a meeting or task outside the visible set. Cached per language
 * in `meeting_generated_docs` by input hash.
 */
import { z } from "zod"

import { generateStructured, interactiveLlmOptions } from "@/lib/ai/llm"
import { dataBlock } from "@/lib/ai/prompts/data-block"
import { sha1Hex } from "@/lib/intelligence/normalize"
import { getEphemeral, onDemandKey, setEphemeral, singleFlight } from "@/lib/intelligence/on-demand"
import {
  getGeneratedDoc,
  upsertGeneratedDoc,
} from "@/lib/intelligence/prep/generated-docs"
import { findRelatedMeetings, type RelatedMeeting } from "@/lib/intelligence/prep/related"
import {
  actionItemDue,
  actionItemOwner,
  clip,
  formatDueDate,
  meetingActionItems,
  meetingDecisions,
  resolveDocLanguage,
  type DocLanguage,
} from "@/lib/intelligence/prep/shared"
import type {
  MeetingRecord,
  MeetingRepository,
  RepoScope,
} from "@/lib/meetings/repository"

export const PREP_PROMPT_VERSION = "m5.prep.1"
const MAX_TASKS = 20
const MAX_DECISIONS_PER_MEETING = 8
const MAX_LIST_ITEMS = 6

export type PrepTask = {
  taskId: string
  title: string
  meetingId: string
  owner?: string
  /** `DD.MM.YYYY` */
  due?: string
}

export type PrepBrief = {
  goal: string
  whereWeLeftOff: Array<{ text: string; meetingId: string }>
  openTasks: PrepTask[]
  previousDecisions: Array<{ text: string; meetingId: string }>
  suggestedQuestions: string[]
  suggestedAgenda: string[]
}

export type PrepBriefResult = {
  brief: PrepBrief | null
  related: RelatedMeeting[]
  language: DocLanguage
  generatedAt?: string
  aiRunId?: string
  /** The cached brief was built from different inputs than today's. */
  stale?: boolean
  /** Generation served from cache (same input hash). */
  cached?: boolean
  /**
   * Generated for this caller only and not saved: callers without
   * `meeting:write` never write the shared cached brief.
   */
  ephemeral?: boolean
}

export type PrepContextMeeting = {
  alias: string
  meetingId: string
  title: string
  startedAt: string
  overview?: string
  decisions: string[]
}

export type PrepContext = {
  language: DocLanguage
  meeting: { title: string; startedAt: string; attendees: string[] }
  meetings: PrepContextMeeting[]
  tasks: Array<PrepTask & { alias: string; meetingAlias: string }>
}

export const prepBriefSchema = z.object({
  goal: z.string(),
  whereWeLeftOff: z.array(z.object({ text: z.string(), meeting: z.string() })),
  openTasks: z.array(z.object({ task: z.string() })),
  previousDecisions: z.array(z.object({ text: z.string(), meeting: z.string() })),
  suggestedQuestions: z.array(z.string()),
  suggestedAgenda: z.array(z.string()),
})

export type PrepBriefOutput = z.infer<typeof prepBriefSchema>

function attendeeNames(meeting: MeetingRecord): string[] {
  const names = (meeting.participantDetails ?? []).map((participant) => participant.name || participant.email || "")

  return [...new Set([...names, ...(meeting.participants ?? [])].map((name) => name.trim()).filter(Boolean))]
}

function attendeeKeys(meeting: MeetingRecord): Set<string> {
  const keys = new Set<string>()

  for (const participant of meeting.participantDetails ?? []) {
    if (participant.name) keys.add(participant.name.trim().toLowerCase())
    if (participant.email) keys.add(participant.email.trim().toLowerCase())
  }
  for (const name of meeting.participants ?? []) keys.add(name.trim().toLowerCase())

  return keys
}

/** Loads the related meetings and their open tasks (visible ones only). */
export async function buildPrepContext(
  meetings: MeetingRepository,
  meeting: MeetingRecord,
  related: RelatedMeeting[],
  language: DocLanguage
): Promise<PrepContext> {
  const attendees = attendeeKeys(meeting)
  const contextMeetings: PrepContextMeeting[] = []
  const tasks: Array<PrepTask & { alias: string; meetingAlias: string; assignedToAttendee: boolean }> = []

  for (const candidate of related) {
    const full = await meetings.getMeeting(candidate.meetingId, { includeTranscript: false })

    if (!full) continue

    const alias = `M${contextMeetings.length + 1}`

    contextMeetings.push({
      alias,
      meetingId: full.id,
      title: full.title,
      startedAt: full.startedAt,
      overview: full.summary?.overview ? clip(full.summary.overview, 600) : undefined,
      decisions: meetingDecisions(full)
        .slice(0, MAX_DECISIONS_PER_MEETING)
        .map((decision) => clip(decision, 300)),
    })

    for (const item of meetingActionItems(full)) {
      if (item.status !== "open" || !item.id) continue

      const owner = actionItemOwner(item)

      tasks.push({
        alias: "",
        meetingAlias: alias,
        taskId: item.id,
        title: clip(item.title, 200),
        meetingId: full.id,
        owner,
        due: actionItemDue(item),
        assignedToAttendee: Boolean(owner && attendees.has(owner.toLowerCase())),
      })
    }
  }

  const selected = tasks
    .sort((a, b) => Number(b.assignedToAttendee) - Number(a.assignedToAttendee))
    .slice(0, MAX_TASKS)
    .map(({ assignedToAttendee, ...task }, index) => {
      void assignedToAttendee
      return { ...task, alias: `T${index + 1}` }
    })

  return {
    language,
    meeting: { title: meeting.title, startedAt: meeting.startedAt, attendees: attendeeNames(meeting) },
    meetings: contextMeetings,
    tasks: selected,
  }
}

function contextBlock(context: PrepContext): string {
  const he = context.language === "he"
  const blocks = context.meetings.map((meeting) => {
    const lines = [`[${meeting.alias}] ${formatDueDate(meeting.startedAt) ?? ""} — ${meeting.title}`]

    if (meeting.overview) lines.push(`${he ? "סיכום" : "Summary"}: ${meeting.overview}`)
    if (meeting.decisions.length) {
      lines.push(`${he ? "החלטות" : "Decisions"}:`, ...meeting.decisions.map((decision) => `- ${decision}`))
    }

    const tasks = context.tasks.filter((task) => task.meetingAlias === meeting.alias)

    if (tasks.length) {
      lines.push(
        `${he ? "משימות פתוחות" : "Open tasks"}:`,
        ...tasks.map(
          (task) =>
            `[${task.alias}] ${task.title}${task.owner ? ` — ${task.owner}` : ""}${task.due ? ` — ${task.due}` : ""}`
        )
      )
    }

    return lines.join("\n")
  })

  return blocks.length ? blocks.join("\n\n") : he ? "(אין פגישות קודמות קשורות)" : "(no related past meetings)"
}

export function prepInstructions(context: PrepContext): string {
  const date = formatDueDate(context.meeting.startedAt) ?? context.meeting.startedAt
  const attendees = context.meeting.attendees.join(", ") || "—"

  // Titles, overviews, decisions and task titles are meeting data: tagged
  // blocks (neutralized), never instructions.
  if (context.language === "he") {
    return [
      "הכן/י תדריך הכנה קצר לפגישה הקרובה, בעברית עסקית טבעית.",
      "הפגישה הקרובה:",
      dataBlock("meeting", `${context.meeting.title} (${date})\nמשתתפים: ${attendees}`),
      "",
      "פגישות קודמות קשורות:",
      dataBlock("related_meetings", contextBlock(context)),
      "",
      "כללים:",
      "- goal: משפט אחד על מטרת הפגישה.",
      "- whereWeLeftOff ו-previousDecisions: כל פריט חייב לציין meeting עם מזהה מהרשימה (M1, M2…). אין פריט בלי מקור.",
      "- openTasks: רק מזהי משימות מהרשימה (T1, T2…), החשובות ביותר קודם.",
      `- suggestedQuestions ו-suggestedAgenda: עד ${MAX_LIST_ITEMS} פריטים כל אחד, מבוססים על החומר בלבד.`,
      "- אל תמציא/י עובדות, שמות או תאריכים. כשמגדר לא ידוע — ניסוח ניטרלי (\"יש לבדוק\").",
      "- מונחים טכניים ושמות מוצרים נשארים באנגלית. תאריכים בפורמט DD.MM.YYYY.",
    ].join("\n")
  }

  return [
    "Write a short prep brief for the upcoming meeting.",
    "Upcoming meeting:",
    dataBlock("meeting", `${context.meeting.title} (${date})\nAttendees: ${attendees}`),
    "",
    "Related past meetings:",
    dataBlock("related_meetings", contextBlock(context)),
    "",
    "Rules:",
    "- goal: one sentence on what the meeting should achieve.",
    "- whereWeLeftOff and previousDecisions: every item must cite `meeting` with an id from the list (M1, M2…). No source, no item.",
    "- openTasks: only task ids from the list (T1, T2…), most important first.",
    `- suggestedQuestions and suggestedAgenda: at most ${MAX_LIST_ITEMS} each, grounded in the material.`,
    "- Never invent facts, names or dates.",
  ].join("\n")
}

/** Maps aliases back to ids; drops items citing unknown meetings or tasks. */
export function mapPrepOutput(output: PrepBriefOutput, context: PrepContext): PrepBrief {
  const meetingIds = new Map(context.meetings.map((meeting) => [meeting.alias, meeting.meetingId]))
  const tasks = new Map(context.tasks.map((task) => [task.alias, task]))
  const cited = (items: Array<{ text: string; meeting: string }>) =>
    items.flatMap((item) => {
      const meetingId = meetingIds.get(item.meeting.trim())
      const text = item.text.trim()

      return meetingId && text ? [{ text, meetingId }] : []
    })
  const seenTasks = new Set<string>()
  const list = (items: string[]) =>
    items
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, MAX_LIST_ITEMS)

  return {
    goal: output.goal.trim(),
    whereWeLeftOff: cited(output.whereWeLeftOff).slice(0, MAX_LIST_ITEMS),
    openTasks: output.openTasks.flatMap(({ task }) => {
      const found = tasks.get(task.trim())

      if (!found || seenTasks.has(found.alias)) return []
      seenTasks.add(found.alias)

      const { alias, meetingAlias, ...rest } = found

      void alias
      void meetingAlias
      return [rest]
    }),
    previousDecisions: cited(output.previousDecisions).slice(0, MAX_LIST_ITEMS),
    suggestedQuestions: list(output.suggestedQuestions),
    suggestedAgenda: list(output.suggestedAgenda),
  }
}

function prepInputHash(context: PrepContext): string {
  return sha1Hex(JSON.stringify({ v: PREP_PROMPT_VERSION, context }))
}

/** Every meeting a cached brief was built from or cites. */
function briefMeetingIds(sourceMeetingIds: readonly string[], brief: PrepBrief | null | undefined): string[] {
  const ids = new Set(sourceMeetingIds)

  for (const item of [
    ...(brief?.whereWeLeftOff ?? []),
    ...(brief?.openTasks ?? []),
    ...(brief?.previousDecisions ?? []),
  ]) {
    if (item.meetingId) ids.add(item.meetingId)
  }

  return [...ids]
}

/** True when the caller's scoped repository can see every source meeting. */
async function allSourcesVisible(
  meetings: MeetingRepository,
  sourceMeetingIds: readonly string[],
  brief: PrepBrief | null | undefined
): Promise<boolean> {
  for (const sourceId of briefMeetingIds(sourceMeetingIds, brief)) {
    if (!(await meetings.getMeeting(sourceId, { includeTranscript: false }))) return false
  }

  return true
}

/** Cached brief for the meeting's language, plus today's related meetings. */
export async function getPrepBrief(
  scope: RepoScope,
  meetings: MeetingRepository,
  meeting: MeetingRecord,
  options: { language?: string; now?: Date } = {}
): Promise<PrepBriefResult> {
  const language = resolveDocLanguage(meeting, options.language)
  const related = await findRelatedMeetings(meetings, meeting, { now: options.now })
  const cached = await getGeneratedDoc<PrepBrief>(scope, meeting.id, "prep_brief", language)

  if (!cached) return { brief: null, related, language }

  // The cached brief is shared by everyone who can see this meeting, but its
  // sources may include a private meeting this reader cannot see: then it is
  // not served (the reader can generate one from what they can see).
  if (!(await allSourcesVisible(meetings, cached.sourceMeetingIds, cached.content))) {
    return { brief: null, related, language, stale: true }
  }

  const context = await buildPrepContext(meetings, meeting, related, language)

  return {
    brief: cached.content,
    related,
    language,
    generatedAt: cached.createdAt,
    aiRunId: cached.aiRunId,
    stale: cached.inputHash !== prepInputHash(context),
  }
}

/**
 * Generates (or serves from cache when the inputs are unchanged and `force`
 * is not set) the prep brief. LLM errors propagate to the caller.
 *
 * `meetings` must be the caller's scoped repository: related meetings and
 * their tasks always come from what the caller can see. Only callers with
 * `meeting:write` (`canWrite`) write or overwrite the shared cached row;
 * anyone else gets a brief generated from their own visible meetings that is
 * returned but never persisted (`ephemeral`), so a viewer can neither replace
 * what other members see nor read a brief built from meetings they can't see.
 */
export async function generatePrepBrief(
  scope: RepoScope,
  meetings: MeetingRepository,
  meeting: MeetingRecord,
  options: GeneratePrepOptions
): Promise<PrepBriefResult> {
  if (!options.actorKey) return generatePrepBriefOnce(scope, meetings, meeting, options)

  const language = resolveDocLanguage(meeting, options.language)
  const flightKey = onDemandKey({
    actorKey: options.actorKey,
    meetingId: meeting.id,
    kind: "prep_brief",
    variant: `${language}:${options.force ? "force" : "auto"}`,
  })

  return singleFlight(flightKey, () => generatePrepBriefOnce(scope, meetings, meeting, options))
}

type GeneratePrepOptions = {
  language?: string
  actorUserId?: string
  /** Principal key (`user:…`/`api_key:…`): single-flight and the ephemeral cache. */
  actorKey?: string
  force?: boolean
  now?: Date
  canWrite: boolean
}

async function generatePrepBriefOnce(
  scope: RepoScope,
  meetings: MeetingRepository,
  meeting: MeetingRecord,
  options: GeneratePrepOptions
): Promise<PrepBriefResult> {
  const language = resolveDocLanguage(meeting, options.language)
  const related = await findRelatedMeetings(meetings, meeting, { now: options.now })
  const context = await buildPrepContext(meetings, meeting, related, language)
  const inputHash = prepInputHash(context)
  const cached = await getGeneratedDoc<PrepBrief>(scope, meeting.id, "prep_brief", language)

  // Same input hash = built from exactly the caller's visible context; the
  // source check is defence in depth.
  if (
    cached &&
    cached.inputHash === inputHash &&
    !options.force &&
    (await allSourcesVisible(meetings, cached.sourceMeetingIds, cached.content))
  ) {
    return {
      brief: cached.content,
      related,
      language,
      generatedAt: cached.createdAt,
      aiRunId: cached.aiRunId,
      cached: true,
    }
  }

  // A caller who can't write gets a result that is never persisted: keep it
  // briefly so repeating the same request does not call the model again.
  const ephemeralKey =
    !options.canWrite && options.actorKey
      ? onDemandKey({
          actorKey: options.actorKey,
          meetingId: meeting.id,
          kind: "prep_brief",
          variant: language,
          inputHash,
        })
      : undefined
  const remembered = ephemeralKey ? getEphemeral<PrepBriefResult>(ephemeralKey) : undefined

  if (remembered) return { ...remembered, related }

  const meetingAliases = new Set(context.meetings.map((item) => item.alias))
  const taskAliases = new Set(context.tasks.map((item) => item.alias))
  const result = await generateStructured<PrepBriefOutput>({
    task: "prep_brief",
    ctx: { workspaceId: scope.workspaceId, meetingId: meeting.id, promptVersion: PREP_PROMPT_VERSION },
    language,
    instructions: prepInstructions(context),
    schema: { name: "prep_brief", zod: prepBriefSchema },
    effort: "medium",
    ...interactiveLlmOptions(),
    validate: (value) => [
      ...[...value.whereWeLeftOff, ...value.previousDecisions]
        .filter((item) => !meetingAliases.has(item.meeting.trim()))
        .map((item) => `unknown meeting id ${item.meeting}`),
      ...value.openTasks
        .filter((item) => !taskAliases.has(item.task.trim()))
        .map((item) => `unknown task id ${item.task}`),
    ],
  })
  const brief = mapPrepOutput(result.value, context)

  if (!options.canWrite) {
    const ephemeralResult: PrepBriefResult = {
      brief,
      related,
      language,
      generatedAt: new Date().toISOString(),
      aiRunId: result.aiRunId,
      ephemeral: true,
    }

    if (ephemeralKey) setEphemeral(ephemeralKey, ephemeralResult)
    return ephemeralResult
  }

  const saved = await upsertGeneratedDoc<PrepBrief>(scope, {
    meetingId: meeting.id,
    kind: "prep_brief",
    variant: language,
    inputHash,
    content: brief,
    sourceMeetingIds: context.meetings.map((item) => item.meetingId),
    aiRunId: result.aiRunId,
    createdByUserId: options.actorUserId,
  })

  return {
    brief,
    related,
    language,
    generatedAt: saved?.createdAt ?? new Date().toISOString(),
    aiRunId: result.aiRunId,
  }
}
