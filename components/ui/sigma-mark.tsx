import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

/**
 * The MeetSum Σ mark: four rounded bars in speaker colours 1–4.
 * `sigma` (resting) sums them into Σ; `lanes` lays them out as speaker lanes.
 * Switching `state` animates between the two over --dur-sigma (the brand's
 * motion signature); under reduced motion it is a static Σ.
 * Styles live in app/globals.css (`.ms-sigma`).
 */
export function SigmaMark({
  state = "sigma",
  label,
  className,
  ...props
}: {
  state?: "sigma" | "lanes"
  /** Accessible name; omit when the mark sits next to the visible "MeetSum" word. */
  label?: string
} & Omit<ComponentProps<"svg">, "children">) {
  return (
    <svg
      viewBox="0 0 28 28"
      data-state={state}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("ms-sigma size-6", className)}
      {...props}
    >
      <rect data-bar="1" x="5" y="4" width="18" height="3.4" rx="1.7" />
      <rect data-bar="2" x="5" y="9.3" width="18" height="3.4" rx="1.7" />
      <rect data-bar="3" x="5" y="15.3" width="18" height="3.4" rx="1.7" />
      <rect data-bar="4" x="5" y="20.6" width="18" height="3.4" rx="1.7" />
    </svg>
  )
}
