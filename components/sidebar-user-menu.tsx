"use client"

/**
 * The sidebar's account menu (log out) and the pending-uploads logout
 * confirmation. Loaded on intent by `MainSidebar` (M10 C bundle diet); the
 * sidebar renders an identical static trigger until then.
 */
import { LogOutIcon } from "lucide-react"
import { useState, type ReactNode } from "react"

import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { Dictionary } from "@/lib/i18n/dictionaries"

export function SidebarUserMenu({
  dictionary,
  triggerClassName,
  triggerContent,
  defaultOpen,
  pendingUploads,
  onLogOut,
}: {
  dictionary: Dictionary
  triggerClassName: string
  triggerContent: ReactNode
  defaultOpen?: boolean
  /** Queued offline recordings; logging out with any asks first. */
  pendingUploads: () => number
  /** Clears the queue and the SW caches, then submits the logout form. */
  onLogOut: () => Promise<void>
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)

  // Queued recordings belong to this user on this device; deleting them
  // needs a confirmation.
  function logOut() {
    if (pendingUploads() > 0) {
      setConfirmOpen(true)
      return
    }
    void onLogOut()
  }

  return (
    <>
      <DropdownMenu defaultOpen={defaultOpen}>
        <DropdownMenuTrigger render={<button type="button" className={triggerClassName} />}>
          {triggerContent}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top">
          <DropdownMenuItem variant="destructive" onClick={logOut}>
            <LogOutIcon aria-hidden="true" className="size-4" />
            {dictionary.logOut}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={dictionary.pwaLogoutPendingTitle}
        description={dictionary.pwaLogoutPendingDescription}
        confirmLabel={dictionary.pwaLogoutDiscard}
        onConfirm={onLogOut}
      />
    </>
  )
}
