export const MEETING_STATUS_FLOW = [
  "created",
  "scheduled",
  "media_found",
  "media_uploaded",
  "audio_extracted",
  "transcribing",
  "diarizing",
  "summarizing",
  "indexing",
  "completed",
  "failed",
] as const

export type MeetingStatus = (typeof MEETING_STATUS_FLOW)[number]

export type MeetingStateRecord = {
  id: string
  status: MeetingStatus
}

const statusIndex = new Map<MeetingStatus, number>(
  MEETING_STATUS_FLOW.map((status, index) => [status, index]),
)

export function canTransitionMeeting(
  from: MeetingStatus,
  to: MeetingStatus,
): boolean {
  if (from === to) {
    return true
  }

  if (to === "failed" && from !== "completed") {
    return true
  }

  if (from === "failed" || from === "completed") {
    return false
  }

  return statusIndex.get(to) === (statusIndex.get(from) ?? -1) + 1
}

export function transitionMeeting<T extends MeetingStateRecord>(
  meeting: T,
  nextStatus: MeetingStatus,
): T {
  if (!canTransitionMeeting(meeting.status, nextStatus)) {
    throw new Error(
      `Invalid meeting status transition: ${meeting.status} -> ${nextStatus}`,
    )
  }

  return { ...meeting, status: nextStatus }
}
