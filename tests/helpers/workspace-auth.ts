import { createSessionCookie } from "@/lib/auth/session"
import {
  createInMemoryWorkspaceStore,
  type WorkspaceStore,
} from "@/lib/workspaces/store"
import type { WorkspaceRole } from "@/lib/workspaces/types"

export const TEST_SESSION_SECRET = "test-session-secret-for-authz"

/** Adds `email` to `workspaceId` with `role` through the public store API. */
export async function addMember(
  store: WorkspaceStore,
  workspaceId: string,
  email: string,
  role: WorkspaceRole
) {
  const user = await store.upsertUser({ email })
  const { token } = await store.createInvitation({
    workspaceId,
    email,
    role: role === "owner" ? "admin" : role,
  })

  await store.acceptInvitation({ token, user })
  if (role === "owner") await store.setMemberRole({ workspaceId, userId: user.id, role })

  return user
}

/** A workspace owned by `ownerEmail`, returned with the owner user. */
export async function seedWorkspace(
  store: WorkspaceStore,
  name: string,
  ownerEmail: string
) {
  const owner = await store.upsertUser({ email: ownerEmail })
  const workspace = await store.createWorkspace({ name, createdByUserId: owner.id })

  return { owner, workspace }
}

export function sessionCookieFor(user: { id: string; email: string }) {
  const cookie = createSessionCookie(
    { userId: user.id, email: user.email },
    { secret: TEST_SESSION_SECRET }
  )

  return `${cookie.name}=${cookie.value}`
}

export function makeRequest(
  url: string,
  options: {
    method?: string
    cookie?: string
    bearer?: string
    origin?: string | null
    body?: unknown
    headers?: Record<string, string>
  } = {}
) {
  const method = options.method ?? "GET"
  const headers: Record<string, string> = { ...(options.headers ?? {}) }

  if (options.cookie) headers.cookie = options.cookie
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`
  if (options.origin !== null && method !== "GET") {
    headers.origin = options.origin ?? new URL(url).origin
  }
  if (options.body !== undefined) headers["content-type"] = "application/json"

  return new Request(url, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
}

export function routeParams<P>(params: P) {
  return { params: Promise.resolve(params) }
}

export function freshStore() {
  return createInMemoryWorkspaceStore()
}
