import { redirect } from "next/navigation"

import { AppShell } from "@/components/app-shell"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { getDictionary } from "@/lib/i18n/dictionaries"
import { isSupportedLocale, type SupportedLocale } from "@/lib/i18n/locales"
import { buildMeetingIntelligence } from "@/lib/intelligence"
import { selectRecentRooms } from "@/lib/rooms"

import { resolveServerPageAuth } from "./server-auth"

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  const supportedLocale: SupportedLocale = isSupportedLocale(locale)
    ? locale
    : "en"
  const auth = await resolveServerPageAuth()

  if (auth.kind === "anonymous") {
    redirect(`/${supportedLocale}/login`)
  }

  const dictionary = getDictionary(supportedLocale)

  if (auth.kind === "no_workspace") {
    return (
      <NoWorkspaceState
        dictionary={dictionary}
        locale={supportedLocale}
        email={auth.user.email}
      />
    )
  }

  const [meetingList, rooms] = await Promise.all([
    auth.meetings.listMeetings({ limit: 5 }),
    auth.meetings.listRooms().catch(() => []),
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
        email: auth.user.email,
        ...(auth.user.name ? { name: auth.user.name } : {}),
        ...(auth.user.picture ? { picture: auth.user.picture } : {}),
      }}
    />
  )
}
