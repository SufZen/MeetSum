import type {
  ActionItem,
  MeetingContext,
  MeetingParticipant,
  MeetingRecord,
} from "@/lib/meetings/repository"

export type RoomTask = ActionItem & {
  meetingId: string
  meetingTitle: string
}

export type RoomParticipant = Pick<MeetingParticipant, "name" | "email" | "role"> & {
  meetingCount: number
}

export type RoomArtifact = {
  id: string
  meetingId: string
  meetingTitle: string
  artifactType: "recording" | "transcript" | "smart_notes"
  artifactName: string
}

export type RoomMeetingSummary = {
  id: string
  title: string
  status: MeetingRecord["status"]
  startedAt: string
  overview: string
  openTasks: number
  participants: number
  artifacts: number
}

export type RoomDetail = {
  room: MeetingContext & { meetingCount: number }
  stats: {
    meetings: number
    completedMeetings: number
    processingMeetings: number
    openTasks: number
    participants: number
    artifacts: number
  }
  meetings: RoomMeetingSummary[]
  openTasks: RoomTask[]
  participants: RoomParticipant[]
  artifacts: RoomArtifact[]
}

const processingStatuses = new Set([
  "media_uploaded",
  "audio_extracted",
  "transcribing",
  "diarizing",
  "summarizing",
  "indexing",
])

function participantKey(participant: MeetingParticipant) {
  return participant.email?.toLowerCase() ?? participant.name.toLowerCase()
}

export function buildRoomDetail(
  room: MeetingContext & { meetingCount: number },
  meetings: MeetingRecord[]
): RoomDetail {
  const openTasks: RoomTask[] = []
  const participants = new Map<string, RoomParticipant>()
  const artifacts: RoomArtifact[] = []

  for (const meeting of meetings) {
    for (const task of meeting.summary?.actionItems ?? []) {
      if (task.status === "open") {
        openTasks.push({
          ...task,
          meetingId: meeting.id,
          meetingTitle: meeting.title,
        })
      }
    }

    for (const participant of meeting.participantDetails ?? []) {
      const key = participantKey(participant)
      const current = participants.get(key)

      participants.set(key, {
        name: participant.name,
        email: participant.email,
        role: participant.role,
        meetingCount: (current?.meetingCount ?? 0) + 1,
      })
    }

    for (const artifact of meeting.meetConferenceRecords?.flatMap(
      (record) => record.artifacts
    ) ?? []) {
      artifacts.push({
        id: artifact.id,
        meetingId: meeting.id,
        meetingTitle: meeting.title,
        artifactType: artifact.artifactType,
        artifactName: artifact.artifactName,
      })
    }
  }

  return {
    room,
    stats: {
      meetings: meetings.length,
      completedMeetings: meetings.filter((meeting) => meeting.status === "completed")
        .length,
      processingMeetings: meetings.filter((meeting) =>
        processingStatuses.has(meeting.status)
      ).length,
      openTasks: openTasks.length,
      participants: participants.size,
      artifacts: artifacts.length,
    },
    meetings: meetings.map((meeting) => ({
      id: meeting.id,
      title: meeting.title,
      status: meeting.status,
      startedAt: meeting.startedAt,
      overview: meeting.summary?.overview ?? "",
      openTasks:
        meeting.summary?.actionItems.filter((task) => task.status === "open")
          .length ?? 0,
      participants:
        meeting.participantDetails?.length || meeting.participants.length || 0,
      artifacts:
        meeting.meetConferenceRecords?.reduce(
          (total, record) => total + record.artifacts.length,
          0
        ) ?? 0,
    })),
    openTasks,
    participants: [...participants.values()].sort(
      (left, right) => right.meetingCount - left.meetingCount
    ),
    artifacts,
  }
}

export type RoomSuggestion = {
  name: string
  reason: string
  meetingCount: number
  meetingIds: string[]
}

/**
 * Suggest room names from meeting titles, recurring patterns, and tags.
 * Extracts common prefixes/patterns from titles and recurring participant groups.
 */
export function suggestRooms(
  meetings: MeetingRecord[],
  existingRoomNames: string[]
): RoomSuggestion[] {
  const existingSet = new Set(existingRoomNames.map((name) => name.toLowerCase()))
  const suggestions = new Map<string, RoomSuggestion>()

  // Strategy 1: Extract common title prefixes
  // E.g., "Weekly standup - Week 1", "Weekly standup - Week 2" → "Weekly standup"
  const titleCounts = new Map<string, string[]>()

  for (const meeting of meetings) {
    const title = meeting.title.trim()

    // Try splitting on common delimiters
    for (const separator of [" - ", " — ", " | ", " · ", ": ", " #"]) {
      const index = title.indexOf(separator)

      if (index > 3) {
        const prefix = title.slice(0, index).trim()
        const existing = titleCounts.get(prefix) ?? []

        existing.push(meeting.id)
        titleCounts.set(prefix, existing)
      }
    }

    // Also try matching "Title (date/number)" pattern
    const parenMatch = title.match(/^(.{4,}?)\s*\(/)

    if (parenMatch) {
      const prefix = parenMatch[1].trim()
      const existing = titleCounts.get(prefix) ?? []

      existing.push(meeting.id)
      titleCounts.set(prefix, existing)
    }
  }

  for (const [prefix, meetingIds] of titleCounts) {
    if (meetingIds.length >= 2 && !existingSet.has(prefix.toLowerCase())) {
      suggestions.set(prefix.toLowerCase(), {
        name: prefix,
        reason: `${meetingIds.length} meetings share this title pattern`,
        meetingCount: meetingIds.length,
        meetingIds: [...new Set(meetingIds)],
      })
    }
  }

  // Strategy 2: Common tags across multiple meetings
  const tagMeetings = new Map<string, string[]>()

  for (const meeting of meetings) {
    for (const tag of meeting.tags ?? []) {
      const tagKey = String(tag)

      // Skip generic language/AI tags
      if (
        ["hebrew", "english", "portuguese", "spanish", "italian", "mixed-language", "technical"].includes(
          tagKey
        )
      )
        continue

      const existing = tagMeetings.get(tagKey) ?? []

      existing.push(meeting.id)
      tagMeetings.set(tagKey, existing)
    }
  }

  for (const [tag, meetingIds] of tagMeetings) {
    if (meetingIds.length >= 3 && !existingSet.has(tag)) {
      const uniqueIds = [...new Set(meetingIds)]

      if (!suggestions.has(tag)) {
        suggestions.set(tag, {
          name: tag.charAt(0).toUpperCase() + tag.slice(1).replace(/-/g, " "),
          reason: `${uniqueIds.length} meetings tagged "${tag}"`,
          meetingCount: uniqueIds.length,
          meetingIds: uniqueIds,
        })
      }
    }
  }

  return [...suggestions.values()]
    .sort((a, b) => b.meetingCount - a.meetingCount)
    .slice(0, 5)
}
