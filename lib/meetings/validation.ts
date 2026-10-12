import { z } from "zod"

import type { CreateMeetingInput } from "@/lib/meetings/repository"

const meetingSourceSchema = z.enum([
  "upload",
  "pwa_recorder",
  "google_meet",
  "desktop_recorder",
  "meeting_bot",
])

const createMeetingSchema = z.object({
  title: z.string().trim().min(1),
  source: meetingSourceSchema,
  language: z.string().trim().min(2).optional(),
  startedAt: z.string().datetime({ offset: true }),
  participants: z.array(z.string().trim().min(1)).default([]),
})

/**
 * Parses a create-meeting request body. `defaultLanguage` (from the
 * workspace `meetingLanguageMode`, see resolveDefaultMeetingLanguage) is used
 * when the body omits `language`. Ownership/visibility are never taken from
 * the body: callers set them from the authenticated principal.
 */
export function parseCreateMeetingInput(
  payload: unknown,
  options: { defaultLanguage?: string } = {}
): CreateMeetingInput {
  const result = createMeetingSchema.safeParse(payload)

  if (!result.success) {
    throw new Error("Invalid meeting payload")
  }

  return {
    ...result.data,
    language: result.data.language ?? options.defaultLanguage ?? "he",
  }
}

export function parseRequiredString(payload: unknown, field: string): string {
  const result = z
    .object({ [field]: z.string().trim().min(1) })
    .safeParse(payload)

  if (!result.success) {
    throw new Error(`${field} is required`)
  }

  return result.data[field] as string
}
