"use client"

/**
 * Offline banner (docs/parity/m9.md D5; mounted in the shell). Shown while
 * the browser reports no connection; recordings keep saving to the device.
 */
import { WifiOffIcon } from "lucide-react"

import { useOptionalI18n } from "@/components/i18n-provider"
import { useOnline } from "@/components/pwa/upload-queue-provider"

export function OfflineBanner() {
  const online = useOnline()
  const i18n = useOptionalI18n()

  if (online || !i18n) return null

  return (
    <div role="status" className="flex items-center gap-2 border-b border-line bg-warn-soft px-4 py-2 text-sm text-warn-text">
      <WifiOffIcon aria-hidden="true" className="size-4 shrink-0" />
      <span>{i18n.t("pwaOffline")}</span>
    </div>
  )
}
