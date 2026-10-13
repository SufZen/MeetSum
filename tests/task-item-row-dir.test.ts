import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { TaskItemRow } from "@/components/tasks/task-item-row"
import { getTasksMessages } from "@/lib/i18n/m5/tasks"

/**
 * A task title or quote can be in another language than its meeting (an
 * English task in a Hebrew meeting): their direction comes from the text
 * itself (`dir="auto"`), never from the meeting language.
 */
describe("TaskItemRow direction", () => {
  it("renders the title and the source quote with dir=auto", () => {
    const html = renderToStaticMarkup(
      createElement(TaskItemRow, {
        item: {
          id: "act_1",
          title: "Send the Supabase migration plan",
          status: "open",
          sourceQuote: "I'll send the migration plan",
        },
        meetingId: "m_1",
        meetingStartedAt: "2026-10-15T09:00:00.000Z",
        strings: getTasksMessages("he"),
        members: [],
        today: "2026-10-15",
        onPatch: async () => {},
      })
    )
    const title = /<button[^>]*>(?:(?!<\/button>).)*Send the Supabase migration plan/s.exec(html)?.[0] ?? ""
    const quote = /<blockquote[^>]*>/.exec(html)?.[0] ?? ""

    expect(title).toMatch(/^<button[^>]*dir="auto"/)
    expect(quote).toContain('dir="auto"')
    expect(html).not.toMatch(/dir="rtl"[^>]*>[^<]*Send the Supabase/)
  })

  it("renders read-only values for viewers: no check-off, title edit or editor", () => {
    const strings = getTasksMessages("en")
    const html = renderToStaticMarkup(
      createElement(TaskItemRow, {
        item: { id: "act_1", title: "Send the plan", status: "open", owner: "Dana", dueOn: "2026-10-20" },
        meetingId: "m_1",
        meetingStartedAt: "2026-10-15T09:00:00.000Z",
        strings,
        members: [],
        today: "2026-10-15",
        canEdit: false,
        onPatch: async () => {},
        onDelete: async () => {},
      })
    )

    expect(html).toContain("Send the plan")
    expect(html).toContain("Dana")
    expect(html).not.toContain('role="checkbox"')
    expect(html).not.toContain(`aria-label="${strings.tasksEditDetails}"`)
    expect(html).not.toContain(`aria-label="${strings.tasksDelete}"`)
    expect(html).not.toMatch(/<button[^>]*>Send the plan/)
  })
})
