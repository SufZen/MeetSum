"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

/**
 * Cadence toasts (design-system/README.md §6): bottom-end in both reading
 * directions, surface + line, status colours from tokens (richColors maps to
 * the soft/AA-text pairs), z-index above the recorder dock. Callers put the
 * object's name in the title and offer at most one action.
 */
const Toaster = ({ dir = "ltr", position, ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()
  const endSide = dir === "rtl" ? "left" : "right"

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      dir={dir}
      position={position ?? `bottom-${endSide}`}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />,
      }}
      style={
        {
          zIndex: "var(--z-toast)",
          "--normal-bg": "var(--surface)",
          "--normal-text": "var(--fg)",
          "--normal-border": "var(--line-strong)",
          "--success-bg": "var(--ok-soft)",
          "--success-text": "var(--ok-text)",
          "--success-border": "color-mix(in oklch, var(--ok) 35%, transparent)",
          "--info-bg": "var(--info-soft)",
          "--info-text": "var(--info-text)",
          "--info-border": "color-mix(in oklch, var(--info) 35%, transparent)",
          "--warning-bg": "var(--warn-soft)",
          "--warning-text": "var(--warn-text)",
          "--warning-border": "color-mix(in oklch, var(--warn) 45%, transparent)",
          "--error-bg": "var(--danger-soft)",
          "--error-text": "var(--danger-text)",
          "--error-border": "color-mix(in oklch, var(--danger) 35%, transparent)",
          "--border-radius": "var(--radius-lg)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast text-base shadow-3",
          title: "font-medium",
          description: "text-sm",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
