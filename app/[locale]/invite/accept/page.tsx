import { notFound, redirect } from "next/navigation"

import { InvitationAcceptById } from "@/components/notifications/invitation-accept-by-id"
import { getServerAuthState } from "@/lib/auth/authz"
import { DEFAULT_LOCALE, isSupportedLocale, type SupportedLocale } from "@/lib/i18n/locales"
import { listMyInvitations } from "@/lib/notifications/invitations"
import { getWorkspaceStore } from "@/lib/workspaces/store"

export const dynamic = "force-dynamic"

/** Same id shape `POST /api/me/invitations/[id]/accept` accepts. */
const INVITATION_ID = /^[A-Za-z0-9_-]{1,80}$/

/**
 * In-app invitation acceptance by id (`/[locale]/invite/accept?id=…`), the
 * target of the `invited` notification (M9 C1; the token never leaves the
 * server). Signed in only. Only a pending, unexpired invitation addressed to
 * the session email renders; anything else (unknown, someone else's,
 * expired, revoked, used) is the same 404 as the accept API, so ids cannot be
 * enumerated. The static `accept` segment takes precedence over `[token]`.
 */
export default async function InviteAcceptByIdPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { locale } = await params
  const query = await searchParams
  const supportedLocale: SupportedLocale = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE
  const id = typeof query.id === "string" ? query.id : ""

  if (!INVITATION_ID.test(id)) notFound()

  const auth = await getServerAuthState()

  if (auth.status === "unauthenticated") {
    const returnTo = `/${supportedLocale}/invite/accept?id=${encodeURIComponent(id)}`

    redirect(`/${supportedLocale}/login?returnTo=${encodeURIComponent(returnTo)}`)
  }

  const invitation = (await listMyInvitations(auth.session.user, getWorkspaceStore())).find((item) => item.id === id)

  if (!invitation) notFound()

  return (
    <InvitationAcceptById
      id={invitation.id}
      locale={supportedLocale}
      workspaceName={invitation.workspaceName}
      inviterName={invitation.inviterName}
    />
  )
}
