/**
 * Enriches extracted action items with parsed due dates, resolved owners,
 * priority and source segments (docs/parity/m5.md B4; owner: Package B).
 * Pure.
 *
 * Due date: the Hebrew/English parser on `dueText` wins (`dueSource:
 * "parser"`); otherwise the model's ISO date is accepted only between
 * anchor−1 day and anchor+2 years (`dueSource: "ai"`, due confidence ≤ 0.6);
 * anything else is dropped rather than shown as a fabricated date.
 */
import type { SmartTask } from "@/lib/intelligence"
import { resolveOwner } from "@/lib/tasks/owner-resolution"
import {
  daysBetween,
  DEFAULT_DUE_DATE_TIME_ZONE,
  dueDateFromDueOn,
  localDateIn,
  parseDueDate,
} from "@/lib/tasks/due-date"
import { inferPriority } from "@/lib/tasks/priority"
import type { TaskEnrichContext } from "@/lib/tasks/types"

/** Extraction extras the pipeline may pass along with a SmartTask. */
export type EnrichableTask = SmartTask & {
  /** The model says the cited speaker owns the task ("אני אשלח"). */
  ownerIsSourceSpeaker?: boolean
  sourceSpeakerId?: string
}

const AI_DUE_CONFIDENCE_CAP = 0.6
const MAX_AI_DUE_DAYS = 731

export { dueDateFromDueOn }

function aiDueOn(raw: string | undefined, anchorDate: string, timeZone: string) {
  if (!raw?.trim()) return undefined

  const value = raw.trim()
  const dueOn = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : Number.isNaN(new Date(value).getTime())
      ? undefined
      : localDateIn(value, timeZone)

  if (!dueOn) return undefined

  const delta = daysBetween(anchorDate, dueOn)

  if (delta === undefined || delta < -1 || delta > MAX_AI_DUE_DAYS) return undefined
  return dueOn
}

function segmentAt(ctx: TaskEnrichContext, startMs: number | undefined) {
  if (startMs === undefined || !ctx.segments?.length) return undefined

  return (
    ctx.segments.find(
      (segment) =>
        segment.startMs <= startMs && startMs < (segment.endMs ?? Number.POSITIVE_INFINITY)
    ) ??
    [...ctx.segments].reverse().find((segment) => segment.startMs <= startMs)
  )
}

export function enrichActionItems<T extends EnrichableTask>(items: T[], ctx: TaskEnrichContext): T[] {
  const timeZone = ctx.timeZone ?? DEFAULT_DUE_DATE_TIME_ZONE
  const anchorDate = localDateIn(ctx.meetingStartedAt, timeZone)

  return items.map((item) => {
    const next: T = { ...item }

    // Source segment <-> start time.
    const cited = item.sourceSegmentId
      ? ctx.segments?.find((segment) => segment.id === item.sourceSegmentId)
      : segmentAt(ctx, item.sourceStartMs)

    if (cited) {
      next.sourceSegmentId = cited.id
      next.sourceStartMs = cited.startMs
    }

    // Due date.
    const parsed = item.dueText
      ? parseDueDate(item.dueText, { anchor: ctx.meetingStartedAt, timeZone })
      : null

    if (parsed) {
      next.dueOn = parsed.date
      next.dueSource = "parser"
      next.dueConfidence = parsed.confidence
      next.dueDate = dueDateFromDueOn(parsed.date)
    } else {
      const fromAi = aiDueOn(item.dueOn ?? item.dueDate, anchorDate, timeZone)

      if (fromAi) {
        next.dueOn = fromAi
        next.dueSource = "ai"
        next.dueConfidence = Math.min(item.dueConfidence ?? AI_DUE_CONFIDENCE_CAP, AI_DUE_CONFIDENCE_CAP)
        next.dueDate = dueDateFromDueOn(fromAi)
      } else {
        next.dueOn = undefined
        next.dueSource = undefined
        next.dueConfidence = undefined
        next.dueDate = undefined
      }
    }

    // Owner.
    const owner = resolveOwner({
      ownerText: item.ownerText ?? item.owner,
      ownerIsSourceSpeaker: item.ownerIsSourceSpeaker,
      sourceSpeakerId: item.sourceSpeakerId ?? cited?.speakerId,
      speakers: ctx.speakers,
      participants: ctx.participants,
      members: ctx.members,
      profileAliases: ctx.profileAliases,
    })

    next.ownerText = owner.ownerText ?? item.ownerText ?? item.owner
    next.ownerParticipantId = owner.participantId
    next.ownerSpeakerId = owner.speakerId
    next.ownerUserId = owner.userId
    next.owner = owner.displayName ?? next.ownerText

    // Priority (after the due date, which can bump it).
    next.priority = inferPriority(next, { anchor: ctx.meetingStartedAt, timeZone })

    return next
  })
}
