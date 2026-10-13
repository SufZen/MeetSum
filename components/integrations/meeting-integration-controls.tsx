"use client"

import type { MeetingVisibility } from "@/lib/meetings/repository"

/**
 * Per-meeting integration controls in the meeting header ⋯ menu (owner:
 * Package D; docs/parity/m8.md, D2): the owner-only "Allow integrations for
 * this private meeting" toggle and the email recap override.
 *
 * Step 0 stub: renders nothing.
 */
export function MeetingIntegrationControls({
  meetingId,
  visibility,
  isOwner,
  canManage,
}: {
  meetingId: string
  visibility: MeetingVisibility | undefined
  /** The signed-in user owns the meeting (only the owner may opt a private meeting in). */
  isOwner: boolean
  canManage: boolean
}) {
  void meetingId
  void visibility
  void isOwner
  void canManage

  return null
}
