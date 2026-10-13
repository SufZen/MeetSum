/**
 * Onboarding redirect (M9 Step 0 contract, docs/parity/m9.md C3; owner:
 * Package C). Package C returns true when the user is owner/admin, the
 * workspace is at most 14 days old with 0 meetings, progress is neither
 * dismissed nor completed, and `MEETSUM_ONBOARDING_ENABLED` is not "false".
 * Step 0: always false, never throws. Server-only.
 */
import type { AuthContext } from "@/lib/auth/authz"

export async function shouldRedirectToOnboarding(ctx: AuthContext): Promise<false> {
  void ctx

  return false
}
