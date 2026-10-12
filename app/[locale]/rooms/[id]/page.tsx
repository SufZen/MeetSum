import { notFound, redirect } from "next/navigation"

import { RoomDetailView } from "@/components/room-detail-view"
import { isSupportedLocale, type SupportedLocale } from "@/lib/i18n/locales"
import { buildRoomDetail } from "@/lib/rooms"

import { resolveServerPageAuth } from "../../server-auth"

export default async function RoomDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>
}) {
  const { locale, id } = await params
  const supportedLocale: SupportedLocale = isSupportedLocale(locale)
    ? locale
    : "en"
  const auth = await resolveServerPageAuth()

  if (auth.kind === "anonymous") redirect(`/${supportedLocale}/login`)
  if (auth.kind === "no_workspace") redirect(`/${supportedLocale}`)

  const rooms = await auth.meetings.listRooms()
  const room = rooms.find((r) => r.id === id)

  if (!room) notFound()

  const meetings = await auth.meetings.listMeetingsByContext(id)
  const detail = buildRoomDetail(room, meetings)

  return <RoomDetailView detail={detail} locale={supportedLocale} />
}
