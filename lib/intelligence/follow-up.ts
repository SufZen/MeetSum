/**
 * Follow-up email generation (owner: Package D). Variants are cached in
 * `meeting_generated_docs` by input hash. Step 0 stubs that throw "not
 * implemented (M5)".
 */
import { notImplementedM5, type MeetingRecord } from "@/lib/meetings/repository"

export type FollowUpTone = "formal" | "friendly" | "concise"

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
}

export async function listFollowUpVariants(meeting: MeetingRecord): Promise<FollowUpVariant[]> {
  void meeting
  return notImplementedM5("listFollowUpVariants")
}

export async function generateFollowUpEmail(
  meeting: MeetingRecord,
  options: FollowUpOptions
): Promise<FollowUpVariant> {
  void meeting
  void options
  return notImplementedM5("generateFollowUpEmail")
}
