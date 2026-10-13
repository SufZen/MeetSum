/**
 * Prep brief generation (owner: Package D). Every claim cites a source
 * meeting id. Step 0 stubs that throw "not implemented (M5)".
 */
import type { RelatedMeeting } from "@/lib/intelligence/prep/related"
import {
  notImplementedM5,
  type MeetingRecord,
  type MeetingRepository,
} from "@/lib/meetings/repository"

export type PrepBrief = {
  goal: string
  whereWeLeftOff: Array<{ text: string; meetingId: string }>
  openTasks: Array<{ taskId: string }>
  previousDecisions: Array<{ text: string; meetingId: string }>
  suggestedQuestions: string[]
  suggestedAgenda: string[]
}

export type PrepBriefResult = {
  brief: PrepBrief | null
  related: RelatedMeeting[]
  generatedAt?: string
  aiRunId?: string
}

export async function getPrepBrief(
  meetings: MeetingRepository,
  meeting: MeetingRecord
): Promise<PrepBriefResult> {
  void meetings
  void meeting
  return notImplementedM5("getPrepBrief")
}

export async function generatePrepBrief(
  meetings: MeetingRepository,
  meeting: MeetingRecord,
  options: { language?: string; actorUserId?: string } = {}
): Promise<PrepBriefResult> {
  void meetings
  void meeting
  void options
  return notImplementedM5("generatePrepBrief")
}
