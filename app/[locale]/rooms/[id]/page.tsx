import { notFound, redirect } from "next/navigation"

import { RoomDetailView } from "@/components/room-detail-view"
import { getServerAuthState } from "@/lib/auth/authz"
import { DEFAULT_LOCALE, isSupportedLocale, type SupportedLocale } from "@/lib/i18n/locales"
import { buildRoomDetail } from "@/lib/rooms"

export default async function RoomDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>
}) {
  const { locale, id } = await params
  const supportedLocale: SupportedLocale = isSupportedLocale(locale)
    ? locale
    : DEFAULT_LOCALE
  const auth = await getServerAuthState()

  if (auth.status === "unauthenticated") redirect(`/${supportedLocale}/login`)
  if (auth.status === "no_workspace") redirect(`/${supportedLocale}`)

  const { ctx } = auth

  const rooms = await ctx.meetings.listRooms()
  const room = rooms.find((r) => r.id === id)

  if (!room) notFound()

  const meetings = await ctx.meetings.listMeetingsByContext(id)
  const detail = buildRoomDetail(room, meetings)

  return <RoomDetailView detail={detail} locale={supportedLocale} />
}
