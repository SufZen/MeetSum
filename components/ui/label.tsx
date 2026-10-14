"use client"

import * as React from "react"

import { LABEL_CLASS } from "@/components/ui/input-class"
import { cn } from "@/lib/utils"

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        LABEL_CLASS,
        className
      )}
      {...props}
    />
  )
}

export { Label }
