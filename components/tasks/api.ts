/**
 * Browser client for the M5 action-item and Tasks routes (Package B).
 */
import type { ActionItem, ActionItemPatch, CreateActionItemInput } from "@/lib/meetings/repository"
import type { TaskListPage, TaskListQuery } from "@/lib/tasks/types"

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
  const body = (await response.json().catch(() => ({}))) as T & { error?: string }

  // i18n-allow: internal error code; callers show localized text and never this message
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

export async function patchActionItem(
  meetingId: string,
  id: string,
  patch: ActionItemPatch
): Promise<ActionItem> {
  const body = await request<{ actionItem: ActionItem }>(
    `/api/action-items/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify({ meetingId, ...patch }) }
  )

  return body.actionItem
}

export async function createActionItem(
  meetingId: string,
  input: CreateActionItemInput
): Promise<ActionItem> {
  const body = await request<{ actionItem: ActionItem }>(
    `/api/meetings/${encodeURIComponent(meetingId)}/action-items`,
    { method: "POST", body: JSON.stringify(input) }
  )

  return body.actionItem
}

export async function deleteActionItem(meetingId: string, id: string): Promise<void> {
  await request(
    `/api/action-items/${encodeURIComponent(id)}?meetingId=${encodeURIComponent(meetingId)}`,
    { method: "DELETE" }
  )
}

export async function fetchTasks(query: Partial<TaskListQuery>): Promise<TaskListPage> {
  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value))
  }

  return request<TaskListPage>(`/api/tasks?${params.toString()}`)
}

export async function bulkUpdateTasks(
  ids: string[],
  patch: { status?: "open" | "done"; ownerUserId?: string | null; dueOn?: string | null; priority?: ActionItem["priority"] }
): Promise<{ updated: ActionItem[]; notFound: string[] }> {
  return request(`/api/tasks/bulk`, { method: "POST", body: JSON.stringify({ ids, patch }) })
}
