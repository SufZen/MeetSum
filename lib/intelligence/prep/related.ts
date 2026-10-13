/**
 * Related meetings for a prep brief (M5 D4): over the last 180 days of
 * visible completed meetings (the scoped repository decides visibility),
 * score = participant-email Jaccard × 0.5 + same room × 0.3 + normalized
 * title-token Jaccard × 0.2. Top 5, never the meeting itself.
 */
import { tokenize } from "@/lib/analytics/text"
import type {
  MeetingListItem,
  MeetingRecord,
  MeetingRepository,
} from "@/lib/meetings/repository"

export type RelatedMeeting = {
  meetingId: string
  title: string
  startedAt: string
  score: number
  /** Score components, for display and tests. */
  signals?: { participants: number; room: number; title: number }
}

export const RELATED_WINDOW_DAYS = 180
export const RELATED_LIMIT = 5

type ScorableMeeting = Pick<MeetingRecord, "id" | "title" | "startedAt" | "participants"> &
  Pick<MeetingListItem, "participantDetails" | "contexts">

/** Generic words that say nothing about what a meeting is about. */
const TITLE_STOPWORDS = new Set([
  "meeting",
  "call",
  "sync",
  "weekly",
  "daily",
  "with",
  "and",
  "the",
  "for",
  "פגישה",
  "שיחה",
  "פגישת",
  "שבועית",
  "עם",
  "של",
])

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function participantEmails(meeting: ScorableMeeting): Set<string> {
  const emails = new Set<string>()

  for (const participant of meeting.participantDetails ?? []) {
    if (participant.email) emails.add(participant.email.trim().toLowerCase())
  }
  for (const participant of meeting.participants ?? []) {
    if (EMAIL.test(participant.trim())) emails.add(participant.trim().toLowerCase())
  }

  return emails
}

export function titleTokens(title: string): Set<string> {
  return new Set(
    tokenize(title).filter(
      (token) => token.length >= 2 && !/^\d+$/.test(token) && !TITLE_STOPWORDS.has(token)
    )
  )
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0

  let shared = 0

  for (const value of a) if (b.has(value)) shared += 1

  return shared / (a.size + b.size - shared)
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** Pure scoring of candidates against a meeting. */
export function scoreRelatedMeetings(
  meeting: ScorableMeeting,
  candidates: Array<ScorableMeeting & { status?: string }>,
  options: { now?: Date; limit?: number } = {}
): RelatedMeeting[] {
  const reference = Math.min(
    new Date(meeting.startedAt).getTime() || Date.now(),
    (options.now ?? new Date()).getTime()
  )
  const windowStart = reference - RELATED_WINDOW_DAYS * 24 * 60 * 60 * 1000
  const emails = participantEmails(meeting)
  const rooms = new Set((meeting.contexts ?? []).map((context) => context.id))
  const title = titleTokens(meeting.title)

  return candidates
    .filter((candidate) => candidate.id !== meeting.id)
    .filter((candidate) => !candidate.status || candidate.status === "completed")
    .filter((candidate) => {
      const started = new Date(candidate.startedAt).getTime()

      return Number.isFinite(started) && started >= windowStart && started <= reference
    })
    .map((candidate) => {
      const participants = jaccard(emails, participantEmails(candidate))
      const room = (candidate.contexts ?? []).some((context) => rooms.has(context.id)) ? 1 : 0
      const titleScore = jaccard(title, titleTokens(candidate.title))

      return {
        meetingId: candidate.id,
        title: candidate.title,
        startedAt: candidate.startedAt,
        score: round(participants * 0.5 + room * 0.3 + titleScore * 0.2),
        signals: { participants: round(participants), room, title: round(titleScore) },
      }
    })
    .filter((related) => related.score > 0)
    .sort((a, b) => b.score - a.score || b.startedAt.localeCompare(a.startedAt))
    .slice(0, options.limit ?? RELATED_LIMIT)
}

/**
 * Top related meetings the repository's scope can see (completed, last
 * 180 days before the meeting or now, whichever is earlier).
 */
export async function findRelatedMeetings(
  meetings: MeetingRepository,
  meeting: MeetingRecord,
  options: { now?: Date } = {}
): Promise<RelatedMeeting[]> {
  const page = await meetings.listMeetingsPage({ status: "completed", sort: "recent", limit: 100 })

  return scoreRelatedMeetings(meeting, page.meetings, options)
}
