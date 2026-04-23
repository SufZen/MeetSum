import { cookies } from "next/headers"

import {
  SESSION_COOKIE,
  getSessionSecret,
  parseAllowedEmails,
  verifySessionCookie,
  type UserSession,
} from "@/lib/auth/session"

export async function getCurrentSession(): Promise<UserSession | undefined> {
  const cookieStore = await cookies()

  return verifySessionCookie(cookieStore.get(SESSION_COOKIE)?.value, {
    secret: getSessionSecret(),
    allowedEmails: parseAllowedEmails(process.env.MEETSUM_ALLOWED_EMAILS),
  })
}
