/**
 * Notion handlers for the dev/e2e fake provider server (docs/parity/m8.md,
 * D5 / Acceptance 14). Owner: Package C. Dev and tests only.
 *
 * Keys are `"<METHOD> <path>"`; `:param` segments match one path segment.
 * The state is in memory: pages with their children, so an e2e run can
 * check that a re-export updated the same page and that every rich_text is
 * at most 2000 characters.
 */
import type { FakeProviderHandlers, FakeProviderRequest } from "@/lib/integrations/core/types"

export type FakeNotionState = {
  pages: Map<string, { databaseId: string; properties: unknown; children: unknown[]; archived: boolean }>
}

export function createFakeNotionState(): FakeNotionState {
  return { pages: new Map() }
}

const DATABASE_ID = "fake-notion-db-0001"

function idFromPath(request: FakeProviderRequest, prefix: string): string {
  return decodeURIComponent(request.path.slice(prefix.length).split("/")[0] ?? "")
}

export function createFakeNotionHandlers(state: FakeNotionState = createFakeNotionState()): FakeProviderHandlers {
  let counter = 0

  return {
    "GET /v1/oauth/authorize": (request) => ({
      redirect: `${request.query.redirect_uri}?code=fake_notion_code&state=${encodeURIComponent(request.query.state ?? "")}`,
    }),
    "POST /v1/oauth/token": () => ({
      body: {
        access_token: "fake_notion_access_token",
        token_type: "bearer",
        bot_id: "fake-bot",
        workspace_id: "fake-notion-workspace",
        workspace_name: "סביבת בדיקה",
      },
    }),
    "GET /v1/users/me": () => ({ body: { object: "user", id: "fake-bot", type: "bot" } }),
    "POST /v1/search": () => ({
      body: {
        object: "list",
        results: [
          { object: "database", id: DATABASE_ID, title: [{ plain_text: "פגישות" }], archived: false },
        ],
        has_more: false,
        next_cursor: null,
      },
    }),
    // Only the fake database exists: any other id is a 404, as in real Notion
    // (so a forged destination database id is rejected in the e2e).
    "GET /v1/databases/:id": (request) => {
      const id = idFromPath(request, "/v1/databases/")

      if (id.replace(/-/g, "") !== DATABASE_ID.replace(/-/g, "")) {
        return { status: 404, body: { object: "error", status: 404, code: "object_not_found", message: "Could not find database." } }
      }

      return {
        body: {
          object: "database",
          id,
          title: [{ plain_text: "פגישות" }],
          properties: {
            Name: { name: "Name", type: "title" },
            Date: { name: "Date", type: "date" },
            Participants: { name: "Participants", type: "multi_select" },
          },
        },
      }
    },
    // Pending-create lookup (review fix #4): the fake never loses a write, so nothing to find.
    "POST /v1/databases/:id/query": () => ({ body: { object: "list", results: [], has_more: false, next_cursor: null } }),
    "POST /v1/pages": (request) => {
      const body = request.body as { parent?: { database_id?: string }; properties?: unknown; children?: unknown[] }
      const id = `fake-page-${++counter}`

      state.pages.set(id, {
        databaseId: body.parent?.database_id ?? "",
        properties: body.properties,
        children: [...(body.children ?? [])],
        archived: false,
      })

      return { body: { object: "page", id, url: `https://www.notion.so/${id}`, archived: false } }
    },
    "PATCH /v1/pages/:id": (request) => {
      const page = state.pages.get(idFromPath(request, "/v1/pages/"))

      if (!page || page.archived) return { status: 404, body: { object: "error", status: 404, code: "object_not_found" } }
      page.properties = (request.body as { properties?: unknown }).properties

      return { body: { object: "page", id: idFromPath(request, "/v1/pages/"), archived: false } }
    },
    "GET /v1/blocks/:id/children": (request) => {
      const page = state.pages.get(idFromPath(request, "/v1/blocks/"))

      return {
        body: {
          object: "list",
          results: (page?.children ?? []).map((_, index) => ({ object: "block", id: `${idFromPath(request, "/v1/blocks/")}:${index}` })),
          has_more: false,
        },
      }
    },
    "PATCH /v1/blocks/:id/children": (request) => {
      const page = state.pages.get(idFromPath(request, "/v1/blocks/"))

      if (!page) return { status: 404, body: { object: "error", status: 404, code: "object_not_found" } }
      page.children.push(...((request.body as { children?: unknown[] }).children ?? []))

      return { body: { object: "list", results: [] } }
    },
    "DELETE /v1/blocks/:id": (request) => {
      const [pageId] = idFromPath(request, "/v1/blocks/").split(":")
      const page = state.pages.get(pageId ?? "")

      // Children are addressed as `<pageId>:<index>`; deleting one shifts the rest.
      if (page) page.children.shift()

      return { body: { object: "block", archived: true } }
    },
  }
}
