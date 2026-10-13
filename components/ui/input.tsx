import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        // Cadence: --line-control boundary (>=3:1), brand focus with a 3px halo.
        // Errors are named next to the field (cause + fix), not by colour alone.
        "h-8 w-full min-w-0 rounded-md py-1 border border-line-control bg-surface px-2.5 text-md text-fg transition-[border-color,box-shadow] duration-(--dur-1) ease-standard outline-none placeholder:text-fg-3 focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25 focus-visible:outline-2 focus-visible:outline-transparent disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-disabled aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger/20 md:text-base file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-fg",
        className
      )}
      {...props}
    />
  )
}

export { Input }
