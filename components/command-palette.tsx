"use client"

/**
 * Ctrl/Cmd+K command palette host (docs/parity/m6.md, D1). Tiny on purpose:
 * it only listens for the shortcut (or a `meetsum:palette` window event) and
 * loads the cmdk dialog on first use.
 */
import { useEffect, useState } from "react"
import dynamic from "next/dynamic"

import type { Dictionary } from "@/lib/i18n/dictionaries"

const CommandPaletteDialog = dynamic(
  () => import("@/components/search/command-palette-dialog").then((mod) => mod.CommandPaletteDialog),
  { ssr: false }
)

export const OPEN_PALETTE_EVENT = "meetsum:palette"

/** True for Ctrl+K / Cmd+K without Alt or Shift. */
export function isPaletteShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">) {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k"
}

export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))
}

export function CommandPaletteHost({ locale, dictionary }: { locale: string; dictionary: Dictionary }) {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const show = () => {
      setLoaded(true)
      setOpen(true)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event)) return
      event.preventDefault()
      setLoaded(true)
      setOpen((current) => !current)
    }

    window.addEventListener("keydown", onKeyDown)
    window.addEventListener(OPEN_PALETTE_EVENT, show)

    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener(OPEN_PALETTE_EVENT, show)
    }
  }, [])

  if (!loaded) return null

  return <CommandPaletteDialog open={open} onOpenChange={setOpen} locale={locale} dictionary={dictionary} />
}
