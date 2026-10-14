"use client"

import { LogOutIcon, UserMinusIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import {
  listMembers,
  removeMember,
  updateMemberRole,
  type WorkspaceMember,
} from "@/components/admin/api"
import { ConfirmDialog } from "@/components/admin/confirm-dialog"
import { adminErrorMessage, formatDateTime, roleLabel } from "@/components/admin/labels"
import { useI18n } from "@/components/i18n-provider"
import { SectionState } from "@/components/admin/section-state"
import { useAsyncResource } from "@/components/admin/use-async-resource"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { useWorkspace } from "@/components/workspace-context"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import { formatMessage } from "@/lib/i18n/messages"
import type { SupportedLocale } from "@/lib/i18n/locales"
import { WORKSPACE_ROLES } from "@/lib/workspaces/constants"
import type { WorkspaceRole } from "@/lib/workspaces/types"

function displayName(member: WorkspaceMember) {
  return member.name?.trim() || member.email
}

export function MembersSection({
  dictionary: t,
  locale,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
}) {
  const router = useRouter()
  const { me, can, refresh: refreshMe } = useWorkspace()
  const { timeZone } = useI18n()
  const members = useAsyncResource(listMembers, [] as WorkspaceMember[], (error) =>
    adminErrorMessage(error, t, t.loadFailed)
  )
  const [pendingUserId, setPendingUserId] = useState<string>()
  const [removing, setRemoving] = useState<WorkspaceMember>()
  const canManage = can("members:manage")
  const canManageOwners = can("owners:manage")
  const ownerCount = members.data.filter(
    (member) => member.role === "owner"
  ).length
  const roleOptions = [...WORKSPACE_ROLES].reverse()

  async function changeRole(member: WorkspaceMember, role: WorkspaceRole) {
    if (role === member.role) return

    setPendingUserId(member.userId)
    try {
      await updateMemberRole(member.userId, role)
      members.setData((current) =>
        current.map((item) =>
          item.userId === member.userId ? { ...item, role } : item
        )
      )
      toast.success(t.membersRoleUpdated)

      if (member.userId === me?.user.id) await refreshMe()
    } catch (error) {
      toast.error(adminErrorMessage(error, t, t.actionFailed))
    } finally {
      setPendingUserId(undefined)
    }
  }

  async function confirmRemove(member: WorkspaceMember) {
    try {
      await removeMember(member.userId)

      if (member.userId === me?.user.id) {
        toast.success(t.membersLeft)
        await refreshMe()
        router.refresh()
        return
      }

      members.setData((current) =>
        current.filter((item) => item.userId !== member.userId)
      )
      toast.success(t.membersRemoved)
    } catch (error) {
      toast.error(adminErrorMessage(error, t, t.actionFailed))
      throw error
    }
  }

  const removingSelf = removing?.userId === me?.user.id

  return (
    <SectionState
      loading={members.loading}
      error={members.error}
      empty={members.data.length === 0}
      emptyLabel={t.membersEmpty}
      loadingLabel={t.workspaceLoading}
      retryLabel={t.retry}
      onRetry={() => void members.reload()}
    >
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-140 text-sm">
          <thead className="bg-surface-2 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-start font-medium">
                {t.membersColumnMember}
              </th>
              <th className="px-3 py-2 text-start font-medium">
                {t.membersColumnRole}
              </th>
              <th className="px-3 py-2 text-start font-medium">
                {t.membersColumnJoined}
              </th>
              <th className="px-3 py-2 text-end font-medium">
                {t.columnActions}
              </th>
            </tr>
          </thead>
          <tbody>
            {members.data.map((member) => {
              const isSelf = member.userId === me?.user.id
              const isLastOwner = member.role === "owner" && ownerCount <= 1
              const touchesOwner = member.role === "owner"
              const roleEditable =
                canManage && !isLastOwner && (!touchesOwner || canManageOwners)
              const removable = !isLastOwner && (isSelf || roleEditable)

              return (
                <tr
                  key={member.userId}
                  className="border-t border-line align-middle"
                >
                  <td className="px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {member.picture ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={member.picture}
                          alt=""
                          referrerPolicy="no-referrer"
                          className="size-7 shrink-0 rounded-full object-cover"
                        />
                      ) : (
                        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand/10 text-xs font-semibold text-brand-text">
                          {displayName(member).slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      <div className="min-w-0">
                        <div className="truncate font-medium text-foreground">
                          <bdi>{displayName(member)}</bdi>{" "}
                          {isSelf ? (
                            <span className="text-xs text-muted-foreground">
                              {t.membersYou}
                            </span>
                          ) : null}
                        </div>
                        <div
                          className="truncate text-xs text-muted-foreground"
                          dir="ltr"
                        >
                          <bdi>{member.email}</bdi>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {roleEditable ? (
                      <NativeSelect
                        aria-label={t.membersColumnRole}
                        value={member.role}
                        disabled={pendingUserId === member.userId}
                        onChange={(event) =>
                          void changeRole(
                            member,
                            event.target.value as WorkspaceRole
                          )
                        }
                      >
                        {roleOptions
                          .filter((role) => role !== "owner" || canManageOwners)
                          .map((role) => (
                            <NativeSelectOption key={role} value={role}>
                              {roleLabel(t, role)}
                            </NativeSelectOption>
                          ))}
                      </NativeSelect>
                    ) : (
                      <span
                        className="text-sm text-foreground"
                        title={isLastOwner ? t.membersLastOwner : undefined}
                      >
                        {roleLabel(t, member.role)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatDateTime({ locale, timeZone }, member.createdAt, "date")}
                  </td>
                  <td className="px-3 py-2 text-end">
                    {removable ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => setRemoving(member)}
                      >
                        {isSelf ? (
                          <LogOutIcon data-icon="inline-start" data-directional="" />
                        ) : (
                          <UserMinusIcon data-icon="inline-start" />
                        )}
                        {isSelf ? t.membersLeave : t.membersRemove}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {ownerCount <= 1 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {t.membersLastOwner}
        </p>
      ) : null}
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        title={
          removingSelf
            ? t.membersLeaveTitle
            : formatMessage(t.membersRemoveTitle, {
                name: removing ? displayName(removing) : "",
              })
        }
        description={
          removingSelf ? t.membersLeaveDescription : t.membersRemoveDescription
        }
        confirmLabel={removingSelf ? t.membersLeave : t.membersRemove}
        cancelLabel={t.cancel}
        onConfirm={() => (removing ? confirmRemove(removing) : undefined)}
      />
    </SectionState>
  )
}
