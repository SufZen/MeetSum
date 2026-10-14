"use client"

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { useOptionalI18n } from "@/components/i18n-provider"
import { cn } from "@/lib/utils"

type TooltipSide = NonNullable<TooltipPrimitive.Positioner.Props["side"]>

/**
 * `left`/`right` are deprecated: they map to the logical side with the same
 * on-screen result in `dir`, so the popup's `data-side` (and the arrow
 * classes below) are always top/bottom/inline-start/inline-end (M10 C).
 */
export function logicalTooltipSide(side: TooltipSide, dir: "rtl" | "ltr"): TooltipSide {
  if (side === "left") return dir === "rtl" ? "inline-end" : "inline-start"
  if (side === "right") return dir === "rtl" ? "inline-start" : "inline-end"

  return side
}

function TooltipProvider({
  delay = 0,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  )
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  const dir = useOptionalI18n()?.dir ?? "ltr"

  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={logicalTooltipSide(side, dir)}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-sm bg-fg px-2.5 py-1.5 text-xs text-canvas shadow-3 duration-(--dur-2) has-data-[slot=kbd]:pe-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-xs data-open:animate-ms-pop-in data-closed:animate-out data-closed:fade-out-0",
            className
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] bg-fg fill-fg data-[side=bottom]:top-1 data-[side=inline-end]:top-1/2! data-[side=inline-end]:-start-1 data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:top-1/2! data-[side=inline-start]:-end-1 data-[side=inline-start]:-translate-y-1/2 data-[side=top]:-bottom-2.5" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
