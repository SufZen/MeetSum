/**
 * Google Drive / Docs handlers for the dev/e2e fake provider server
 * (docs/parity/m8.md, D5). Owner: Package C. Dev and tests only.
 * Keys are `"<METHOD> <path>"`; `:param` matches one path segment.
 */
import type { FakeProviderHandlers } from "@/lib/integrations/core/types"

export type FakeGoogleDocsState = { documents: Map<string, { title: string; requests: unknown[][] }> }

export function createFakeGoogleDocsHandlers(
  state: FakeGoogleDocsState = { documents: new Map() }
): FakeProviderHandlers {
  let counter = 0
  const idOf = (path: string) => decodeURIComponent(path.split("/")[3]?.split(":")[0] ?? "")

  return {
    "GET /o/oauth2/v2/auth": (request) => ({
      redirect: `${request.query.redirect_uri}?code=fake_google_code&state=${encodeURIComponent(request.query.state ?? "")}`,
    }),
    "POST /token": () => ({
      body: {
        access_token: "fake_google_access_token",
        refresh_token: "fake_google_refresh_token",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/drive.file",
        token_type: "Bearer",
      },
    }),
    "POST /tokeninfo": () => ({ body: { scope: "https://www.googleapis.com/auth/drive.file", expires_in: 3000 } }),
    "POST /revoke": () => ({ body: {} }),
    "GET /drive/v3/about": () => ({
      body: { user: { permissionId: "fake-permission-id", emailAddress: "member@example.com", displayName: "Member" } },
    }),
    "PATCH /drive/v3/files/:id": () => ({ body: { id: "ok" } }),
    "POST /v1/documents": (request) => {
      const documentId = `fake-doc-${++counter}`

      state.documents.set(documentId, { title: String((request.body as { title?: string }).title ?? ""), requests: [] })

      return { body: { documentId } }
    },
    "GET /v1/documents/:id": (request) =>
      state.documents.has(idOf(request.path))
        ? { body: { body: { content: [{ endIndex: 1 }, { endIndex: 42 }] } } }
        : { status: 404, body: { error: { code: 404, status: "NOT_FOUND" } } },
    "POST /v1/documents/:id": (request) => {
      const document = state.documents.get(idOf(request.path))

      if (!document) return { status: 404, body: { error: { code: 404, status: "NOT_FOUND" } } }
      document.requests.push((request.body as { requests?: unknown[] }).requests ?? [])

      return { body: { replies: [] } }
    },
  }
}
