/**
 * Server-renders a client component inside `I18nProvider` (static markup)
 * for the M9 Package C view tests.
 */
import { createElement, type ComponentProps, type ComponentType, type ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { I18nProvider } from "@/components/i18n-provider"
import { getDictionary } from "@/lib/i18n/dictionaries"
import type { MessageSource } from "@/lib/i18n/messages"

type ProviderProps = Omit<ComponentProps<typeof I18nProvider>, "children">

const Provider = I18nProvider as unknown as ComponentType<ProviderProps>

export function renderWithI18n(
  element: ReactElement,
  locale: "he" | "en" = "he",
  messages: MessageSource = getDictionary(locale) as unknown as MessageSource
): string {
  return renderToStaticMarkup(
    createElement(
      Provider,
      { locale, dir: locale === "he" ? "rtl" : "ltr", timeZone: "Asia/Jerusalem", messages },
      element
    )
  )
}
