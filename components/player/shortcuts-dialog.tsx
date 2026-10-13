"use client"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import type { Dictionary } from "@/lib/i18n/dictionaries"

/** Keys are shown as printed on a US keyboard; matching uses physical codes. */
const ROWS: { keys: string[][]; label: keyof Dictionary }[] = [
  { keys: [["Space"], ["K"]], label: "shortcutsPlayPause" }, // i18n-allow: keycap name as printed
  { keys: [["J"], ["L"]], label: "shortcutsSkip10" },
  { keys: [["←"], ["→"]], label: "shortcutsSkip5" },
  { keys: [["Shift", "<"], ["Shift", ">"]], label: "shortcutsSpeed" }, // i18n-allow: keycap name as printed
  { keys: [["0"], ["9"]], label: "shortcutsPercent" },
  { keys: [["F"]], label: "shortcutsFollow" },
  { keys: [["/"]], label: "shortcutsSearch" },
  { keys: [["M"]], label: "shortcutsMute" },
  { keys: [["?"]], label: "shortcutsHelp" },
]

export function ShortcutsDialog({
  open,
  onOpenChange,
  dictionary: t,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  dictionary: Dictionary
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t.shortcutsTitle}</DialogTitle>
          <DialogDescription>{t.shortcutsLayoutNote}</DialogDescription>
        </DialogHeader>
        <dl className="grid gap-2 text-sm">
          {ROWS.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-4">
              <dt className="text-fg-2">{t[row.label]}</dt>
              <dd dir="ltr" className="flex shrink-0 items-center gap-1.5">
                {row.keys.map((combo) => (
                  <KbdGroup key={combo.join("+")}>
                    {combo.map((key) => (
                      <Kbd key={key}>{key}</Kbd>
                    ))}
                  </KbdGroup>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  )
}
