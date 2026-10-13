/**
 * Onboarding redirect (M9 Step 0 contract, docs/parity/m9.md C3; owner:
 * Package C). True when the user is owner/admin, the workspace is at most 14
 * days old with 0 meetings, progress is neither dismissed nor completed, and
 * `MEETSUM_ONBOARDING_ENABLED` is not "false". Never throws. Server-only.
 *
 * The Step 0 stub returned `Promise<false>`; the return type is widened to
 * `boolean` (the only caller, `app/[locale]/(home)/page.tsx`, already treats it as one).
 */
import type { AuthContext } from "@/lib/auth/authz"
import { computeOnboardingRedirect } from "@/lib/onboarding/service"

export async function shouldRedirectToOnboarding(ctx: AuthContext): Promise<boolean> {
  return computeOnboardingRedirect(ctx)
}
