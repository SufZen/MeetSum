import { describe, expect, it } from "vitest"

import {
  mergeActionItems,
  normalizeTaskTitle,
} from "@/lib/meetings/action-item-merge"
import type { ActionItem } from "@/lib/meetings/repository"

function item(partial: Partial<ActionItem> & { id: string; title: string }): ActionItem {
  return { status: "open", origin: "ai", editedByUser: false, ...partial }
}

function idFactory() {
  let next = 0
  return () => `generated_${++next}`
}

describe("normalizeTaskTitle", () => {
  it("lowercases, collapses punctuation and strips Hebrew niqqud", () => {
    expect(normalizeTaskTitle("  Send   the DECK!! ")).toBe("send the deck")
    expect(normalizeTaskTitle("לִשְׁלוֹחַ הצעת מחיר")).toBe("לשלוח הצעת מחיר")
    expect(normalizeTaskTitle("Ｆｕｌｌwidth—task")).toBe("fullwidth task")
  })
})

describe("mergeActionItems", () => {
  it("keeps a user-renamed task and drops the regenerated duplicate", () => {
    const existing = [
      item({
        id: "act_1",
        title: "Send the signed proposal to Dana",
        originalTitle: "Send proposal",
        editedByUser: true,
      }),
    ]
    const incoming = [item({ id: "task_new", title: "Send proposal" })]

    const plan = mergeActionItems(existing, incoming, idFactory())

    expect(plan.keep.map((entry) => entry.id)).toEqual(["act_1"])
    expect(plan.keep[0].title).toBe("Send the signed proposal to Dana")
    expect(plan.update).toEqual([])
    expect(plan.insert).toEqual([])
    expect(plan.remove).toEqual([])
  })

  it("keeps done and user-created tasks untouched", () => {
    const existing = [
      item({ id: "act_done", title: "Book venue", status: "done" }),
      item({ id: "act_user", title: "Call accountant", origin: "user" }),
    ]
    const incoming = [item({ id: "task_a", title: "Book venue", status: "open" })]

    const plan = mergeActionItems(existing, incoming, idFactory())

    expect(plan.keep.map((entry) => entry.id)).toEqual(["act_done", "act_user"])
    expect(plan.keep[0].status).toBe("done")
    expect(plan.insert).toEqual([])
    expect(plan.remove).toEqual([])
  })

  it("updates an unprotected AI task in place, keeping its id", () => {
    const existing = [item({ id: "act_1", title: "Prepare budget", priority: "normal" })]
    const incoming = [
      item({ id: "task_x", title: "Prepare budget.", priority: "high", owner: "Maya" }),
    ]

    const plan = mergeActionItems(existing, incoming, idFactory())

    expect(plan.update).toHaveLength(1)
    expect(plan.update[0]).toMatchObject({
      id: "act_1",
      title: "Prepare budget.",
      priority: "high",
      owner: "Maya",
      origin: "ai",
      editedByUser: false,
      originalTitle: "Prepare budget.",
    })
    expect(plan.insert).toEqual([])
    expect(plan.remove).toEqual([])
  })

  it("removes stale unprotected tasks and inserts new ones", () => {
    const existing = [item({ id: "act_old", title: "Old idea" })]
    const incoming = [item({ id: "task_new", title: "Fresh idea" })]

    const plan = mergeActionItems(existing, incoming, idFactory())

    expect(plan.remove).toEqual(["act_old"])
    expect(plan.insert).toHaveLength(1)
    expect(plan.insert[0]).toMatchObject({
      id: "task_new",
      title: "Fresh idea",
      origin: "ai",
      originalTitle: "Fresh idea",
    })
  })

  it("matches Hebrew titles that differ only by niqqud", () => {
    const existing = [
      item({
        id: "act_he",
        title: "לשלוח סיכום לצוות עד יום חמישי",
        originalTitle: "לִשְׁלוֹחַ סיכום לצוות",
        editedByUser: true,
      }),
      item({ id: "act_he2", title: "לְעַדְכֵּן את הלקוח" }),
    ]
    const incoming = [
      item({ id: "task_1", title: "לשלוח סיכום לצוות" }),
      item({ id: "task_2", title: "לעדכן את הלקוח" }),
    ]

    const plan = mergeActionItems(existing, incoming, idFactory())

    expect(plan.keep.map((entry) => entry.id)).toEqual(["act_he"])
    expect(plan.update.map((entry) => entry.id)).toEqual(["act_he2"])
    expect(plan.insert).toEqual([])
    expect(plan.remove).toEqual([])
  })

  it("regenerates ids that collide with existing rows", () => {
    const existing = [item({ id: "task_1", title: "Done thing", status: "done" })]
    const incoming = [
      item({ id: "task_1", title: "Brand new thing" }),
      item({ id: "task_1", title: "Another new thing" }),
    ]

    const plan = mergeActionItems(existing, incoming, idFactory())

    expect(plan.insert.map((entry) => entry.id)).toEqual(["generated_1", "generated_2"])
  })
})
