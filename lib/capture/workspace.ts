import { DEFAULT_WORKSPACE_ID } from "@/lib/workspaces/constants"

/**
 * Workspace that receives Zoom/Teams cloud recordings. Platform webhooks are
 * signed by the platform, not by a MeetSum principal, so the target workspace
 * is configured per instance (MEETSUM_CAPTURE_WORKSPACE_ID, default
 * ws_default) until per-workspace capture connections exist.
 */
export function getCaptureWorkspaceId(
  env: Record<string, string | undefined> = process.env
): string {
  return env.MEETSUM_CAPTURE_WORKSPACE_ID?.trim() || DEFAULT_WORKSPACE_ID
}
