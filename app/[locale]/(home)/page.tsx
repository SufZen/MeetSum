import { redirect } from "next/navigation"

import { AppShell } from "@/components/app-shell"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { can, canManageMeeting, getServerAuthState } from "@/lib/auth/authz"
import { resolveShellDeepLink } from "@/lib/client/shell-deep-link"
import { hasShellIntent, parseShellUrl } from "@/lib/client/shell-url"
import { getDictionary } from "@/lib/i18n/dictionaries"
import { DEFAULT_LOCALE, isSupportedLocale, type SupportedLocale } from "@/lib/i18n/locales"
import { shouldRedirectToOnboarding } from "@/lib/onboarding/redirect"
import { selectRecentRooms } from "@/lib/rooms"

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams])

  // Screenshot run only (M9 D3): `?__error=1` renders the error page.
  if (process.env.NODE_ENV !== "production" && query.__error === "1") {
    throw new Error("Development error trigger") // i18n-allow: developer-only trigger, never shown in production
  }
  const supportedLocale: SupportedLocale = isSupportedLocale(locale)
    ? locale
    : DEFAULT_LOCALE
  const auth = await getServerAuthState()

  if (auth.status === "unauthenticated") {
    redirect(`/${supportedLocale}/login`)
  }

  const dictionary = getDictionary(supportedLocale)

  if (auth.status === "no_workspace") {
    return (
      <NoWorkspaceState
        dictionary={dictionary}
        locale={supportedLocale}
        email={auth.session.user.email}
      />
    )
  }

  const { ctx } = auth
  const user = auth.session.user

  // M9 onboarding (Package C): fresh owner/admin workspaces go to the wizard,
  // unless the URL is a deep link or an OAuth callback (never drop those).
  if (!hasShellIntent(query) && (await shouldRedirectToOnboarding(ctx).catch(() => false))) {
    redirect(`/${supportedLocale}/onboarding`)
  }
  // Lightweight inbox rows; the selected meeting's detail and transcript are
  // fetched client-side, except a deep-linked meeting outside the first page,
  // which is read here through the visibility-scoped repository (M9 D1).
  const shell = parseShellUrl(query)
  const [meetingPage, rooms] = await Promise.all([
    ctx.meetings.listMeetingsPage({ limit: 5 }),
    ctx.meetings.listRooms().catch(() => []),
  ])
  const meetings = meetingPage.meetings
  const deepLink = await resolveShellDeepLink(shell, meetings, (id) =>
    ctx.meetings.getMeeting(id, { includeTranscript: false })
  )
  const initialDetail =
    deepLink.kind === "fetched"
      ? {
          meeting: deepLink.meeting,
          permissions: {
            canWrite: can(ctx.role, "meeting:write"),
            canManage: canManageMeeting(ctx, deepLink.meeting),
          },
        }
      : undefined

  return (
    <AppShell
      dictionary={dictionary}
      locale={supportedLocale}
      meetings={meetings}
      rooms={selectRecentRooms(rooms)}
      workspaceId={ctx.workspace.id}
      initialDetail={initialDetail}
      unavailableMeetingId={deepLink.kind === "unavailable" ? deepLink.meetingId : undefined}
      user={{
        id: user.id,
        email: user.email,
        ...(user.name ? { name: user.name } : {}),
        ...(user.picture ? { picture: user.picture } : {}),
      }}
    />
  )
}
