import { redirect } from "next/navigation"

import { AppShell } from "@/components/app-shell"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { getServerAuthState } from "@/lib/auth/authz"
import { getDictionary } from "@/lib/i18n/dictionaries"
import { DEFAULT_LOCALE, isSupportedLocale, type SupportedLocale } from "@/lib/i18n/locales"
import { shouldRedirectToOnboarding } from "@/lib/onboarding/redirect"
import { selectRecentRooms } from "@/lib/rooms"

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
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

  // M9 onboarding (Package C): fresh owner/admin workspaces go to the wizard.
  if (await shouldRedirectToOnboarding(ctx).catch(() => false)) {
    redirect(`/${supportedLocale}/onboarding`)
  }
  // Lightweight inbox rows; the selected meeting's detail and transcript are
  // fetched client-side.
  const [meetingPage, rooms] = await Promise.all([
    ctx.meetings.listMeetingsPage({ limit: 5 }),
    ctx.meetings.listRooms().catch(() => []),
  ])
  const meetings = meetingPage.meetings

  return (
    <AppShell
      dictionary={dictionary}
      locale={supportedLocale}
      meetings={meetings}
      rooms={selectRecentRooms(rooms)}
      user={{
        email: user.email,
        ...(user.name ? { name: user.name } : {}),
        ...(user.picture ? { picture: user.picture } : {}),
      }}
    />
  )
}
