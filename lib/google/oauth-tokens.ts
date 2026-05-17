import { getDatabasePool } from "@/lib/db/client"
import { decryptSecret, encryptSecret } from "@/lib/auth/secret-crypto"

function createId(prefix: string, stable: string) {
  return `${prefix}_${Buffer.from(stable).toString("base64url").slice(0, 40)}`
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

function workspaceAccountIdFor(subject: string) {
  const domain = subject.split("@")[1] ?? "workspace"

  return domain === "realization.co.il"
    ? "workspace_realization"
    : createId("workspace", domain)
}

async function ensureGoogleIdentity(subject: string) {
  const normalizedSubject = normalizeEmail(subject)
  const pool = getDatabasePool()
  const workspaceAccountId = workspaceAccountIdFor(normalizedSubject)
  const domain = normalizedSubject.split("@")[1] ?? "realization.co.il"
  const identityId = createId("gident", normalizedSubject)

  await pool.query(
    `
      insert into workspace_accounts (id, domain, admin_email, auth_model)
      values ($1, $2, $3, 'user_oauth')
      on conflict (id) do update
        set admin_email = excluded.admin_email,
            auth_model = excluded.auth_model
    `,
    [
      workspaceAccountId,
      domain,
      process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL ?? normalizedSubject,
    ]
  )

  await pool.query(
    `
      insert into google_identities (
        id, workspace_account_id, subject_email, sync_enabled
      )
      values ($1, $2, $3, true)
      on conflict (workspace_account_id, subject_email)
      do update set sync_enabled = excluded.sync_enabled
    `,
    [identityId, workspaceAccountId, normalizedSubject]
  )

  return identityId
}

export async function saveGoogleWorkspaceOAuthConnection(options: {
  subject: string
  googleUserId?: string
  refreshToken?: string | null
  scope?: string | null
}) {
  const identityId = await ensureGoogleIdentity(options.subject)
  const encryptedRefreshToken = options.refreshToken
    ? encryptSecret(options.refreshToken)
    : null

  await getDatabasePool().query(
    `
      update google_identities
      set google_user_id = coalesce($2, google_user_id),
          oauth_refresh_token = coalesce($3, oauth_refresh_token),
          oauth_scope = coalesce($4, oauth_scope),
          oauth_connected_at = now(),
          oauth_last_error = null
      where id = $1
    `,
    [
      identityId,
      options.googleUserId ?? null,
      encryptedRefreshToken,
      options.scope ?? null,
    ]
  )
}

export async function getGoogleWorkspaceOAuthRefreshToken(subject: string) {
  const result = await getDatabasePool().query(
    `
      select oauth_refresh_token
      from google_identities
      where subject_email = $1
      limit 1
    `,
    [normalizeEmail(subject)]
  )
  const encryptedToken = (
    result.rows[0] as { oauth_refresh_token?: string | null } | undefined
  )?.oauth_refresh_token

  if (!encryptedToken) {
    throw new Error(
      "Google Workspace OAuth is not connected. Sign in again to grant Workspace permissions."
    )
  }

  try {
    return decryptSecret(encryptedToken)
  } catch {
    throw new Error(
      "Google Workspace OAuth token cannot be decrypted. Reconnect Google Workspace."
    )
  }
}

export async function getGoogleWorkspaceOAuthConnectionStatus(subject: string) {
  if (process.env.MEETSUM_STORAGE !== "postgres") {
    return { connected: false, scopes: undefined as string | undefined }
  }

  try {
    const result = await getDatabasePool().query(
      `
        select oauth_refresh_token, oauth_scope, oauth_connected_at, oauth_last_error
        from google_identities
        where subject_email = $1
        limit 1
      `,
      [normalizeEmail(subject)]
    )
    const row = result.rows[0] as
      | {
          oauth_refresh_token?: string | null
          oauth_scope?: string | null
          oauth_connected_at?: Date | string | null
          oauth_last_error?: string | null
        }
      | undefined

    return {
      connected: Boolean(row?.oauth_refresh_token),
      scopes: row?.oauth_scope ?? undefined,
      connectedAt: row?.oauth_connected_at
        ? row.oauth_connected_at instanceof Date
          ? row.oauth_connected_at.toISOString()
          : row.oauth_connected_at
        : undefined,
      lastError: row?.oauth_last_error ?? undefined,
    }
  } catch {
    return { connected: false, scopes: undefined as string | undefined }
  }
}
