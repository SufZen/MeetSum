"use client"

import { Loader2Icon } from "lucide-react"

import { useOptionalI18n } from "@/components/i18n-provider"
import { cn } from "@/lib/utils"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  const i18n = useOptionalI18n()

  return (
    <Loader2Icon
      role="status"
      aria-label={i18n?.t("shellLoading") ?? "…"}
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
