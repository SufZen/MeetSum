import { cookies } from "next/headers"

import {
  SESSION_COOKIE,
  getSessionSecret,
  verifySessionCookie,
  type UserSession,
} from "@/lib/auth/session"

/**
 * Signed-in identity from the session cookie (server components / legacy
 * callers). This proves identity only; workspace access is resolved per
 * request by `withAuthz` / `getServerAuthContext` (lib/auth/authz.ts).
 */
export async function getCurrentSession(): Promise<UserSession | undefined> {
  const cookieStore = await cookies()

  return verifySessionCookie(cookieStore.get(SESSION_COOKIE)?.value, {
    secret: getSessionSecret(),
  })
}
