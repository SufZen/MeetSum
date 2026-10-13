/**
 * Optional domain-wide-delegation path for the Docs export (docs/parity/m8.md,
 * C2, auth step 2). Owner: Package C.
 *
 * Only when `MEETSUM_GOOGLE_DOCS_DWD=true`, the workspace DWD strategy is a
 * service-account one (private key or keyless signJwt; the `user-oauth`
 * strategy ignores scopes, so it never qualifies), and the requester's
 * email domain equals the workspace Google subject's domain. The document
 * is then created in the requester's own Drive.
 */
import { createDelegatedGoogleClient, getWorkspaceAuthStatus, type WorkspaceAuthStrategy } from "@/lib/google/auth"
import { getWorkspaceGoogleSubject } from "@/lib/google/workspace-subject"
import { ProviderError } from "@/lib/integrations/core/types"
import { GOOGLE_DOCS_SCOPE, GOOGLE_DRIVE_FILE_SCOPE } from "@/lib/integrations/google-docs/oauth"
import type { Workspace } from "@/lib/workspaces/types"

const SERVICE_ACCOUNT_STRATEGIES: readonly WorkspaceAuthStrategy[] = ["json-key", "key-file", "keyless-iam-signjwt"]

export type GoogleDocsDwdDecision =
  | { allowed: true; subject: string }
  | { allowed: false; reason: "disabled" | "strategy" | "no_subject" | "domain_mismatch" | "no_user" }

function domainOf(email: string | undefined): string | undefined {
  const at = email?.lastIndexOf("@") ?? -1

  return email && at > 0 ? email.slice(at + 1).trim().toLowerCase() : undefined
}

export function googleDocsDwdDecision(input: {
  userEmail: string | undefined
  workspace: Pick<Workspace, "id" | "googleSubject">
  env?: NodeJS.ProcessEnv
  strategy?: WorkspaceAuthStrategy
}): GoogleDocsDwdDecision {
  const env = input.env ?? process.env

  if (env.MEETSUM_GOOGLE_DOCS_DWD?.trim().toLowerCase() !== "true") return { allowed: false, reason: "disabled" }
  if (!input.userEmail) return { allowed: false, reason: "no_user" }

  const strategy = input.strategy ?? getWorkspaceAuthStatus().strategy

  if (!SERVICE_ACCOUNT_STRATEGIES.includes(strategy)) return { allowed: false, reason: "strategy" }

  const subject = getWorkspaceGoogleSubject(input.workspace, env)

  if (!subject) return { allowed: false, reason: "no_subject" }

  const userDomain = domainOf(input.userEmail)

  if (!userDomain || userDomain !== domainOf(subject)) return { allowed: false, reason: "domain_mismatch" }

  return { allowed: true, subject: input.userEmail.trim().toLowerCase() }
}

/** A delegated access token for the requester (documents + drive.file). */
export async function googleDocsDwdAccessToken(userEmail: string): Promise<string> {
  try {
    const client = await createDelegatedGoogleClient(userEmail, [GOOGLE_DOCS_SCOPE, GOOGLE_DRIVE_FILE_SCOPE])
    const { token } = await client.getAccessToken()

    if (!token) throw new Error("no token")

    return token
  } catch {
    // Google's error text (which may name the subject or the key) is never kept.
    throw new ProviderError("auth", "google_docs_dwd_failed")
  }
}
