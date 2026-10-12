import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const exchange = vi.hoisted(() => vi.fn())
const saveConnection = vi.hoisted(() => vi.fn(async () => {}))
const audit = vi.hoisted(() => vi.fn(async () => {}))

vi.mock("@/lib/auth/google", () => ({
  exchangeGoogleCodeForIdentity: exchange,
  getGoogleOAuthConfig: () => ({ clientId: "c", clientSecret: "s", redirectUri: "r" }),
}))
vi.mock("@/lib/google/oauth-tokens", () => ({
  saveGoogleWorkspaceOAuthConnection: saveConnection,
}))
vi.mock("@/lib/audit", () => ({ recordAuditLog: audit }))

import { GET } from "@/app/api/auth/google/callback/route"
import { SESSION_COOKIE, verifySessionCookie } from "@/lib/auth/session"
import { setWorkspaceStoreForTesting, type WorkspaceStore } from "@/lib/workspaces/store"

import { TEST_SESSION_SECRET, freshStore, routeParams, seedWorkspace } from "./helpers/workspace-auth"

function callback(returnTo = "/en", state = "state-1") {
  return GET(
    new Request(`http://localhost/api/auth/google/callback?code=abc&state=${state}`, {
      headers: { cookie: `meetsum_oauth_state=${encodeURIComponent(`state-1:${returnTo}`)}` },
    }),
    routeParams({})
  )
}

function sessionFrom(response: Response) {
  const header = response.headers.get("set-cookie") ?? ""
  const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header)

  return match ? verifySessionCookie(match[1], { secret: TEST_SESSION_SECRET }) : undefined
}

describe("Google OAuth callback", () => {
  let store: WorkspaceStore

  beforeEach(() => {
    store = freshStore()
    setWorkspaceStoreForTesting(store)
    vi.stubEnv("MEETSUM_SESSION_SECRET", TEST_SESSION_SECRET)
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost")
    vi.stubEnv("MEETSUM_ALLOWED_EMAILS", "")
    vi.stubEnv("GOOGLE_WORKSPACE_SUBJECT", "")
    vi.stubEnv("GOOGLE_WORKSPACE_ADMIN_EMAIL", "")
    exchange.mockReset()
    saveConnection.mockClear()
    audit.mockClear()
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    setWorkspaceStoreForTesting(undefined)
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("rejects a state mismatch", async () => {
    const response = await callback("/en", "forged")

    expect(response.headers.get("location")).toBe("http://localhost/en/login?error=oauth_state")
    expect(exchange).not.toHaveBeenCalled()
  })

  it("issues a v2 session for an existing member and records last login", async () => {
    const { owner } = await seedWorkspace(store, "W1", "member@example.com")

    exchange.mockResolvedValue({ email: "Member@Example.com", name: "Mem", googleUserId: "g1" })

    const response = await callback("/he/meetings")

    expect(response.headers.get("location")).toBe("http://localhost/he/meetings")
    expect(sessionFrom(response)).toMatchObject({ v: 2, userId: owner.id, email: "member@example.com" })
    expect((await store.getUserById(owner.id))?.lastLoginAt).toBeTruthy()
    expect(saveConnection).toHaveBeenCalledWith(expect.objectContaining({ subject: "member@example.com" }))
  })

  it("bootstraps allowlisted emails into ws_default", async () => {
    vi.stubEnv("MEETSUM_ALLOWED_EMAILS", "boss@example.com")
    exchange.mockResolvedValue({ email: "boss@example.com" })

    const response = await callback()
    const session = sessionFrom(response)

    expect(session?.email).toBe("boss@example.com")
    expect(await store.getMembership("ws_default", session!.userId)).toMatchObject({ role: "owner" })
  })

  it("denies non-invited, non-member users with no_access and an audit entry", async () => {
    exchange.mockResolvedValue({ email: "stranger@example.com" })

    const response = await callback("/he")

    expect(response.headers.get("location")).toBe("http://localhost/he/login?error=no_access")
    expect(sessionFrom(response)).toBeUndefined()
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.login.denied", actor: "stranger@example.com" })
    )
    expect(saveConnection).not.toHaveBeenCalled()
  })

  it("lets an invitee with a matching pending invite sign in to accept it", async () => {
    const { workspace } = await seedWorkspace(store, "W1", "owner@example.com")
    const { token } = await store.createInvitation({
      workspaceId: workspace.id,
      email: "invitee@example.com",
      role: "member",
    })

    exchange.mockResolvedValue({ email: "invitee@example.com" })

    const response = await callback(`/he/invite/${token}`)

    expect(response.headers.get("location")).toBe(`http://localhost/he/invite/${token}`)
    expect(sessionFrom(response)?.email).toBe("invitee@example.com")
  })

  it("sends a mismatched account back to the invite page with email_mismatch and no session", async () => {
    const { workspace } = await seedWorkspace(store, "W1", "owner@example.com")
    const { token } = await store.createInvitation({
      workspaceId: workspace.id,
      email: "invitee@example.com",
      role: "member",
    })

    exchange.mockResolvedValue({ email: "someone-else@example.com" })

    const response = await callback(`/en/invite/${token}`)

    expect(response.headers.get("location")).toBe(
      `http://localhost/en/invite/${token}?error=email_mismatch`
    )
    expect(sessionFrom(response)).toBeUndefined()
  })

  it("ignores unsafe returnTo values", async () => {
    await seedWorkspace(store, "W1", "member@example.com")
    exchange.mockResolvedValue({ email: "member@example.com" })

    const response = await callback("//evil.example/x")

    expect(response.headers.get("location")).toBe("http://localhost/en")
  })
})
