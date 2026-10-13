/**
 * In-app notifications (`notifications` table; UI is M9). Owner: Package C.
 * Step 0 stub: a no-op.
 */

export type NotificationKind = "mention" | "reply" | "task_assigned"

export type EnqueueNotificationInput = {
  workspaceId: string
  userId: string
  kind: NotificationKind
  payload: Record<string, unknown>
}

export async function enqueueNotification(
  input: EnqueueNotificationInput
): Promise<{ id?: string; skipped: boolean }> {
  void input
  return { skipped: true }
}
