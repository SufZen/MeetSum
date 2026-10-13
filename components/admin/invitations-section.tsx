"use client"

import { CopyIcon, MailPlusIcon, RotateCwIcon, XCircleIcon } from "lucide-react"
import { useState, type FormEvent } from "react"
import { toast } from "sonner"

import {
  createInvitation,
  listInvitations,
  resendInvitation,
  revokeInvitation,
  type CreatedInvitation,
  type InvitableRole,
  type WorkspaceInvitation,
} from "@/components/admin/api"
import { ConfirmDialog } from "@/components/admin/confirm-dialog"
import {
  adminErrorMessage,
  formatDateTime,
  invitationStatusLabel,
  roleLabel,
} from "@/components/admin/labels"
import { SectionState } from "@/components/admin/section-state"
import { useAsyncResource } from "@/components/admin/use-async-resource"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { useI18n } from "@/components/i18n-provider"
import { useWorkspace } from "@/components/workspace-context"
import { formatMessage, type Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"

const INVITABLE_ROLES: InvitableRole[] = ["viewer", "member", "admin"]

async function copyToClipboard(value: string) {
  await navigator.clipboard.writeText(value)
}

export function InvitationsSection({
  dictionary: t,
  locale,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
}) {
  const { can } = useWorkspace()
  const { timeZone } = useI18n()
  const invitations = useAsyncResource(
    listInvitations,
    [] as WorkspaceInvitation[],
    (error) => adminErrorMessage(error, t, t.loadFailed)
  )
  const [inviteOpen, setInviteOpen] = useState(false)
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<InvitableRole>("member")
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<CreatedInvitation>()
  const [revoking, setRevoking] = useState<WorkspaceInvitation>()
  const [pendingId, setPendingId] = useState<string>()
  const canManage = can("members:manage")

  function upsert(invitation: WorkspaceInvitation) {
    invitations.setData((current) => [
      invitation,
      ...current.filter((item) => item.id !== invitation.id),
    ])
  }

  async function copyLink(url: string) {
    try {
      await copyToClipboard(url)
      toast.success(t.invitationsLinkCopied)
    } catch {
      toast.error(t.actionFailed)
    }
  }

  async function submitInvite(event: FormEvent) {
    event.preventDefault()

    const address = email.trim()

    if (!address) return

    setSending(true)
    try {
      const created = await createInvitation({ email: address, role })

      if (created.invitation.id) upsert(created.invitation)
      else await invitations.reload()

      setInviteOpen(false)
      setEmail("")
      setResult(created)
    } catch (error) {
      toast.error(adminErrorMessage(error, t, t.actionFailed))
    } finally {
      setSending(false)
    }
  }

  async function resend(invitation: WorkspaceInvitation) {
    setPendingId(invitation.id)
    try {
      const resent = await resendInvitation(invitation.id)

      if (resent.invitation.id) upsert(resent.invitation)
      setResult(resent)
    } catch (error) {
      toast.error(adminErrorMessage(error, t, t.actionFailed))
    } finally {
      setPendingId(undefined)
    }
  }

  async function confirmRevoke(invitation: WorkspaceInvitation) {
    try {
      await revokeInvitation(invitation.id)
      invitations.setData((current) =>
        current.map((item) =>
          item.id === invitation.id ? { ...item, status: "revoked" } : item
        )
      )
      toast.success(t.invitationsRevoked)
    } catch (error) {
      toast.error(adminErrorMessage(error, t, t.actionFailed))
      throw error
    }
  }

  return (
    <div className="grid gap-3">
      {canManage ? (
        <div className="flex justify-end">
          <Button onClick={() => setInviteOpen(true)}>
            <MailPlusIcon data-icon="inline-start" />
            {t.invitationsInvite}
          </Button>
        </div>
      ) : null}

      <SectionState
        loading={invitations.loading}
        error={invitations.error}
        empty={invitations.data.length === 0}
        emptyLabel={t.invitationsEmpty}
        loadingLabel={t.workspaceLoading}
        retryLabel={t.retry}
        onRetry={() => void invitations.reload()}
      >
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-155 text-sm">
            <thead className="bg-surface-2 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-start font-medium">
                  {t.invitationsColumnEmail}
                </th>
                <th className="px-3 py-2 text-start font-medium">
                  {t.invitationsRoleLabel}
                </th>
                <th className="px-3 py-2 text-start font-medium">
                  {t.invitationsColumnStatus}
                </th>
                <th className="px-3 py-2 text-start font-medium">
                  {t.invitationsColumnExpires}
                </th>
                <th className="px-3 py-2 text-end font-medium">
                  {t.columnActions}
                </th>
              </tr>
            </thead>
            <tbody>
              {invitations.data.map((invitation) => (
                <tr
                  key={invitation.id}
                  className="border-t border-line align-top"
                >
                  <td className="px-3 py-2">
                    <div className="truncate font-medium" dir="ltr">
                      <bdi>{invitation.email}</bdi>
                    </div>
                    {invitation.lastSendError ? (
                      <div className="mt-1 text-xs text-destructive">
                        {formatMessage(t.invitationsSendError, {
                          error: invitation.lastSendError,
                        })}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">{roleLabel(t, invitation.role)}</td>
                  <td className="px-3 py-2">
                    <Badge
                      variant={
                        invitation.status === "pending"
                          ? "secondary"
                          : "outline"
                      }
                    >
                      {invitationStatusLabel(t, invitation.status)}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatDateTime({ locale, timeZone }, invitation.expiresAt)}
                  </td>
                  <td className="px-3 py-2">
                    {canManage && invitation.status === "pending" ? (
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pendingId === invitation.id}
                          onClick={() => void resend(invitation)}
                        >
                          <RotateCwIcon data-icon="inline-start" />
                          {t.invitationsResend}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          onClick={() => setRevoking(invitation)}
                        >
                          <XCircleIcon data-icon="inline-start" />
                          {t.invitationsRevoke}
                        </Button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionState>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <form onSubmit={submitInvite} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{t.invitationsInviteTitle}</DialogTitle>
              <DialogDescription>
                {t.invitationsInviteDescription}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="invite-email">{t.invitationsEmailLabel}</Label>
              <Input
                id="invite-email"
                type="email"
                dir="ltr"
                autoComplete="off"
                required
                autoFocus
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="invite-role">{t.invitationsRoleLabel}</Label>
              <NativeSelect
                id="invite-role"
                value={role}
                onChange={(event) =>
                  setRole(event.target.value as InvitableRole)
                }
              >
                {INVITABLE_ROLES.map((option) => (
                  <NativeSelectOption key={option} value={option}>
                    {roleLabel(t, option)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setInviteOpen(false)}
              >
                {t.cancel}
              </Button>
              <Button type="submit" disabled={sending || !email.trim()}>
                {sending ? t.invitationsSending : t.invitationsSend}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(result)}
        onOpenChange={(open) => !open && setResult(undefined)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.invitationsLinkTitle}</DialogTitle>
            <DialogDescription>
              {result?.emailSent
                ? t.invitationsEmailSent
                : t.invitationsEmailNotSent}
            </DialogDescription>
          </DialogHeader>
          {result?.inviteUrl ? (
            <div className="flex items-center gap-2">
              <Input
                readOnly
                dir="ltr"
                value={result.inviteUrl}
                onFocus={(event) => event.currentTarget.select()}
                aria-label={t.invitationsLinkTitle}
              />
              <Button
                variant="outline"
                onClick={() => void copyLink(result.inviteUrl)}
              >
                <CopyIcon data-icon="inline-start" />
                {t.invitationsCopyLink}
              </Button>
            </div>
          ) : null}
          {result?.sendError ? (
            <p className="text-xs text-destructive">
              {formatMessage(t.invitationsSendError, {
                error: result.sendError,
              })}
            </p>
          ) : null}
          <DialogFooter>
            <Button onClick={() => setResult(undefined)}>{t.done}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(revoking)}
        onOpenChange={(open) => !open && setRevoking(undefined)}
        title={formatMessage(t.invitationsRevokeTitle, {
          email: revoking?.email ?? "",
        })}
        description={t.invitationsRevokeDescription}
        confirmLabel={t.invitationsRevoke}
        cancelLabel={t.cancel}
        onConfirm={() => (revoking ? confirmRevoke(revoking) : undefined)}
      />
    </div>
  )
}
