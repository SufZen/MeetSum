import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md py-2 border border-line-control bg-surface px-2.5 text-md text-fg transition-[border-color,box-shadow] duration-(--dur-1) ease-standard outline-none placeholder:text-fg-3 focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25 focus-visible:outline-2 focus-visible:outline-transparent disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-disabled aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger/20 md:text-base",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
