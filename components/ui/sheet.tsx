"use client"

import { useOptionalI18n } from "@/components/i18n-provider"
import * as React from "react"
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetPortal({ ...props }: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/10 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs",
        className
      )}
      {...props}
    />
  )
}

/** Logical sides; `left`/`right` are deprecated physical aliases (see `logicalSheetSide`). */
export type SheetSide = "top" | "bottom" | "start" | "end"

/**
 * Maps a deprecated physical side to the logical one with the same on-screen
 * result in `dir` (`left` is `start` in LTR and `end` in RTL), so old
 * callers keep their placement while the classes stay logical (M10 C).
 */
export function logicalSheetSide(side: SheetSide | "left" | "right", dir: "rtl" | "ltr"): SheetSide {
  if (side === "left") return dir === "rtl" ? "end" : "start"
  if (side === "right") return dir === "rtl" ? "start" : "end"

  return side
}

function SheetContent({
  className,
  children,
  // The pre-M10 default: physically right in both directions (unchanged).
  side = "right",
  showCloseButton = true,
  closeLabel,
  ...props
}: SheetPrimitive.Popup.Props & {
  /** `start`/`end` follow the text direction. `left`/`right` are deprecated aliases. */
  side?: SheetSide | "left" | "right"
  showCloseButton?: boolean
  /** Accessible name of the close button (pass a localized string). */
  closeLabel?: string
}) {
  const i18n = useOptionalI18n()
  const closeText = i18n?.t("shellClose") ?? ""
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-side={logicalSheetSide(side, props.dir === "rtl" || props.dir === "ltr" ? props.dir : (i18n?.dir ?? "ltr"))}
        className={cn(
          "fixed z-50 flex flex-col gap-4 bg-popover bg-clip-padding text-sm text-popover-foreground shadow-lg transition duration-200 ease-in-out data-ending-style:opacity-0 data-starting-style:opacity-0 data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=bottom]:data-ending-style:translate-y-[2.5rem] data-[side=bottom]:data-starting-style:translate-y-[2.5rem] data-[side=start]:inset-y-0 data-[side=start]:start-0 data-[side=start]:h-full data-[side=start]:w-3/4 data-[side=start]:border-e data-[side=start]:data-ending-style:-translate-x-[2.5rem] rtl:data-[side=start]:data-ending-style:translate-x-[2.5rem] data-[side=start]:data-starting-style:-translate-x-[2.5rem] rtl:data-[side=start]:data-starting-style:translate-x-[2.5rem] data-[side=end]:inset-y-0 data-[side=end]:end-0 data-[side=end]:h-full data-[side=end]:w-3/4 data-[side=end]:border-s data-[side=end]:data-ending-style:translate-x-[2.5rem] rtl:data-[side=end]:data-ending-style:-translate-x-[2.5rem] data-[side=end]:data-starting-style:translate-x-[2.5rem] rtl:data-[side=end]:data-starting-style:-translate-x-[2.5rem] data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=top]:data-ending-style:translate-y-[-2.5rem] data-[side=top]:data-starting-style:translate-y-[-2.5rem] data-[side=start]:sm:max-w-sm data-[side=end]:sm:max-w-sm",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-3 end-3"
                size="icon-sm"
              />
            }
          >
            <XIcon
            />
            <span className="sr-only">{closeLabel ?? closeText}</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-0.5 p-4", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  )
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn(
        "font-heading text-base font-medium text-foreground",
        className
      )}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
