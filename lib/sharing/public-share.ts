import type { MeetingRecord, MeetingShare } from "@/lib/meetings/repository"
import { getShareLookup } from "@/lib/meetings/store"
import { getAppSettings } from "@/lib/settings/app-settings"
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspaces/constants"

export type PublicShare = { share: MeetingShare; meeting: MeetingRecord }

/**
 * Resolves a public share token across workspaces (M2). The lookup itself
 * only returns active, unexpired shares of `link` meetings; on top of that
 * the owning workspace must still allow public sharing. Anything else is
 * reported as "not found" so a token never reveals why it stopped working.
 */
export async function lookupPublicShare(
  token: string
): Promise<PublicShare | undefined> {
  if (!token) return undefined

  const result = await getShareLookup().getShareByToken(token)

  if (!result) return undefined

  const settings = await getAppSettings(
    result.meeting.workspaceId ?? DEFAULT_WORKSPACE_ID
  )

  return settings.publicSharingEnabled ? result : undefined
}
