import { notFound, redirect } from "next/navigation"

import { getCurrentSession } from "@/lib/auth/server"
import { isSupportedLocale, type SupportedLocale } from "@/lib/i18n/locales"
import { meetingRepository } from "@/lib/meetings/store"
import { buildRoomDetail } from "@/lib/rooms"
import { RoomDetailView } from "@/components/room-detail-view"

export default async function RoomDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>
}) {
  const { locale, id } = await params
  const supportedLocale: SupportedLocale = isSupportedLocale(locale)
    ? locale
    : "en"
  const session = await getCurrentSession()

  if (!session) redirect(`/${supportedLocale}/login`)

  const rooms = await meetingRepository.listRooms()
  const room = rooms.find((r) => r.id === id)

  if (!room) notFound()

  const meetings = await meetingRepository.listMeetingsByContext(id)
  const detail = buildRoomDetail(room, meetings)

  return <RoomDetailView detail={detail} locale={supportedLocale} />
}
