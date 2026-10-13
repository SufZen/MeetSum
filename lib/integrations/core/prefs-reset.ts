/**
 * Stale private opt-in (M8 review fix #5). `meeting_integration_prefs.
 * allow_private_push` is the owner's per-meeting consent to push a PRIVATE
 * meeting to integrations. An opt-in set while the meeting was shared
 * (`workspace`/`link`) was given for a shared meeting, not a private one,
 * so making the meeting private clears it: the owner has to opt in again,
 * knowingly, for the private meeting. The email recap preference is kept.
 *
 * Ownership changes need no hook: the privacy gate honours the opt-in only
 * when it was set by the CURRENT owner (`allow_private_set_by_user_id`).
 *
 * Called by the meeting visibility route BEFORE the visibility is written,
 * so a failure here never leaves a private meeting with a stale opt-in.
 */
import { getIntegrationStore, type IntegrationStore } from "@/lib/integrations/core/store"
import type { MeetingVisibility } from "@/lib/meetings/repository"

export async function resetPrivateOptInForVisibilityChange(
  change: { workspaceId: string; meetingId: string; from: MeetingVisibility | undefined; to: MeetingVisibility },
  store?: IntegrationStore
): Promise<boolean> {
  if (change.to !== "private" || change.from === "private") return false

  const db = store ?? (await getIntegrationStore())
  const prefs = await db.getPrefs(change.workspaceId, change.meetingId)

  if (!prefs?.allowPrivatePush && !prefs?.allowPrivateSetByUserId) return false

  await db.upsertPrefs(change.workspaceId, change.meetingId, { allowPrivatePush: false, allowPrivateSetByUserId: null })
  return true
}
