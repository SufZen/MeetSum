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
