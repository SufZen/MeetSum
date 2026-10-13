import { redirect } from "next/navigation"

import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard"
import { DEFAULT_ASR_GLOSSARY } from "@/lib/ai/asr"
import { getServerAuthState } from "@/lib/auth/authz"
import { DEFAULT_LOCALE, isSupportedLocale, type SupportedLocale } from "@/lib/i18n/locales"
import { getOnboardingState, isOnboardingEnabled } from "@/lib/onboarding/service"

export const dynamic = "force-dynamic"

/** Built-in Hebrew business terms offered as quick-add suggestions. */
const GLOSSARY_SUGGESTIONS = 8

/**
 * Onboarding wizard (docs/parity/m9.md C3). Signed in, with a workspace;
 * steps are computed live on the server. Off with MEETSUM_ONBOARDING_ENABLED=false.
 */
export default async function OnboardingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  const supportedLocale: SupportedLocale = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE
  const auth = await getServerAuthState()

  if (auth.status === "unauthenticated") redirect(`/${supportedLocale}/login`)
  if (auth.status === "no_workspace") redirect(`/${supportedLocale}`)
  if (!isOnboardingEnabled() || auth.ctx.principal !== "user") redirect(`/${supportedLocale}`)

  const state = await getOnboardingState(auth.ctx)

  return (
    <OnboardingWizard
      locale={supportedLocale}
      initial={{ ...state, enabled: true }}
      glossarySuggestions={DEFAULT_ASR_GLOSSARY.terms.slice(0, GLOSSARY_SUGGESTIONS).map((term) => term.term)}
    />
  )
}
