import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

/** M5 panels are code split (next/dynamic) like the other meeting panels. */
describe("meeting workspace bundle", () => {
  const source = readFileSync("components/meeting-workspace.tsx", "utf8")

  it.each([
    ["ClipList", "@/components/clips/clip-list"],
    ["CommentsDrawer", "@/components/comments/comments-drawer"],
    ["PrepPanel", "@/components/intelligence/prep-panel"],
    ["FollowUpPanel", "@/components/intelligence/follow-up-panel"],
    ["ActionItemEditor", "@/components/tasks/action-item-editor"],
  ])("loads %s with next/dynamic, never statically", (name, path) => {
    expect(source).not.toMatch(new RegExp(`^import \\{[^}]*\\b${name}\\b[^}]*\\} from "${path}"`, "m"))
    expect(source).toContain(`import("${path}")`)
  })
})
