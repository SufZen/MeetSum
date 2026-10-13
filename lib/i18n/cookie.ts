/** Options for the `meetsum_locale` cookie (readable by the client; one year). */
export function localeCookieOptions(env: { NODE_ENV?: string } = process.env) {
  return {
    httpOnly: false,
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  }
}
