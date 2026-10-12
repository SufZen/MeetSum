import { redirect } from "next/navigation"

import { AppShell } from "@/components/app-shell"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { getServerAuthState } from "@/lib/auth/authz"
import { getDictionary } from "@/lib/i18n/dictionaries"
import { isSupportedLocale, type SupportedLocale } from "@/lib/i18n/locales"
import { buildMeetingIntelligence } from "@/lib/intelligence"
import { selectRecentRooms } from "@/lib/rooms"

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  const supportedLocale: SupportedLocale = isSupportedLocale(locale)
    ? locale
    : "en"
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
  const [meetingList, rooms] = await Promise.all([
    ctx.meetings.listMeetings({ limit: 5 }),
    ctx.meetings.listRooms().catch(() => []),
  ])
  const meetings = meetingList.map((meeting) => {
    const intelligence =
      meeting.intelligence ?? buildMeetingIntelligence(meeting)

    return {
      ...meeting,
      tags: meeting.tags ?? intelligence.tags,
      intelligence,
      languageMetadata:
        meeting.languageMetadata ?? intelligence.languageMetadata,
    }
  })

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
