import { NextResponse } from "next/server"

import { recordAuditLog } from "@/lib/audit"
import { withPublicRoute } from "@/lib/auth/authz"
import { exchangeGoogleCodeForIdentity, getGoogleOAuthConfig } from "@/lib/auth/google"
import { localeOfPath, parseInviteReturnTo, safeReturnTo } from "@/lib/auth/return-to"
import {
  OAUTH_STATE_COOKIE,
  createSessionCookie,
  getSessionSecret,
  readRequestCookie,
} from "@/lib/auth/session"
import { localeCookieOptions } from "@/lib/i18n/cookie"
import { DEFAULT_LOCALE, LOCALE_COOKIE } from "@/lib/i18n/locales"
import { saveGoogleWorkspaceOAuthConnection } from "@/lib/google/oauth-tokens"
import { getUserPreferences } from "@/lib/users/preferences"
import { isBootstrapEmail } from "@/lib/workspaces/bootstrap"
import { getWorkspaceStore } from "@/lib/workspaces/store"
import { normalizeEmail } from "@/lib/workspaces/tokens"

function splitState(stored: string | undefined): [string, string | undefined] {
  const value = stored ?? ""
  const index = value.indexOf(":")

  return index < 0 ? [value, undefined] : [value.slice(0, index), value.slice(index + 1)]
}

export const GET = withPublicRoute("Google OAuth redirect target", async (request) => {
  const requestUrl = new URL(request.url)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? requestUrl.origin
  const state = requestUrl.searchParams.get("state")
  const code = requestUrl.searchParams.get("code")
  const [storedState, storedReturnTo] = splitState(
    readRequestCookie(request, OAUTH_STATE_COOKIE)
  )
  const returnTo = safeReturnTo(storedReturnTo)
  const loginUrl = new URL(`/${localeOfPath(returnTo)}/login`, appUrl)
  const redirectWithError = (url: URL, error: string) => {
    url.searchParams.set("error", error)
    const response = NextResponse.redirect(url)

    response.cookies.delete(OAUTH_STATE_COOKIE)
    return response
  }

  if (!code || !state || !storedState || state !== storedState) {
    return redirectWithError(loginUrl, "oauth_state")
  }

  try {
    const identity = await exchangeGoogleCodeForIdentity(code, getGoogleOAuthConfig())
    const email = normalizeEmail(identity.email)
    const store = getWorkspaceStore()
    const user = await store.upsertUser({
      email,
      name: identity.name,
      picture: identity.picture,
      login: true,
    })

    if (user.disabledAt) {
      await recordAuditLog({
        action: "auth.login.denied",
        // Instance-level: the user belongs to no workspace here.
        workspaceId: null,
        actor: email,
        actorUserId: user.id,
        metadata: { reason: "disabled" },
      })
      return redirectWithError(loginUrl, "no_access")
    }

    if (isBootstrapEmail(email)) {
      await store.ensureBootstrap()
    }

    const memberships = await store.listMembershipsForUser(user.id)
    let allowed = memberships.length > 0

    if (!allowed) {
      const invite = parseInviteReturnTo(returnTo)
      const found = invite ? await store.findInvitationByToken(invite.token) : undefined

      if (invite && found && found.invitation.status === "pending") {
        if (normalizeEmail(found.invitation.email) !== email) {
          await recordAuditLog({
            action: "auth.login.denied",
            workspaceId: found.workspace.id,
            actor: email,
            actorUserId: user.id,
            targetType: "invitation",
            targetId: found.invitation.id,
            metadata: { reason: "email_mismatch" },
          })
          return redirectWithError(new URL(returnTo, appUrl), "email_mismatch")
        }

        allowed = true
      }
    }

    if (!allowed) {
      await recordAuditLog({
        action: "auth.login.denied",
        // Instance-level: the user belongs to no workspace here.
        workspaceId: null,
        actor: email,
        actorUserId: user.id,
        metadata: { reason: "no_access" },
      })
      return redirectWithError(loginUrl, "no_access")
    }

    const session = createSessionCookie(
      { userId: user.id, email, name: identity.name, picture: identity.picture },
      { secret: getSessionSecret() }
    )

    await saveGoogleWorkspaceOAuthConnection({
      subject: email,
      googleUserId: identity.googleUserId,
      refreshToken: identity.refreshToken,
      scope: identity.scope,
    })

    // M9 A1: a stored UI locale becomes the cookie (and the default home's prefix).
    const userLocale = (await getUserPreferences(user.id)).locale
    const target = userLocale && returnTo === `/${DEFAULT_LOCALE}` ? `/${userLocale}` : returnTo
    const response = NextResponse.redirect(new URL(target, appUrl))

    if (userLocale) response.cookies.set(LOCALE_COOKIE, userLocale, localeCookieOptions())

    response.cookies.set(session.name, session.value, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: session.maxAge,
    })
    response.cookies.delete(OAUTH_STATE_COOKIE)

    return response
  } catch (error) {
    console.error("[auth] Google callback failed", error)
    return redirectWithError(loginUrl, "unauthorized")
  }
})
