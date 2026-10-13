import { describe, expect, it } from "vitest"

import { inferPriority } from "@/lib/tasks/priority"

const anchor = "2026-10-15T09:00:00+03:00"

describe("inferPriority", () => {
  it("keeps the model priority when nothing applies", () => {
    expect(inferPriority({ title: "לעדכן את המצגת", priority: "low" }, { anchor })).toBe("low")
    expect(inferPriority({ title: "Update the deck" }, { anchor })).toBe("normal")
  })

  it("bumps urgency words to at least high", () => {
    for (const title of ["דחוף: לשלוח חוזה", "לטפל בזה בהקדם", "באג קריטי", "ASAP fix login", "urgent: call Dana"]) {
      expect(inferPriority({ title, priority: "low" }, { anchor }), title).toBe("high")
    }
  })

  it("goes to urgent for 'דחוף מאוד' and 'היום'", () => {
    expect(inferPriority({ title: "דחוף מאוד לחתום" }, { anchor })).toBe("urgent")
    expect(inferPriority({ title: "לשלוח היום את ההצעה" }, { anchor })).toBe("urgent")
    expect(inferPriority({ title: "x", sourceQuote: "תשלחי עוד היום" }, { anchor })).toBe("urgent")
  })

  it("bumps by due date: within 2 days high, already past urgent", () => {
    expect(inferPriority({ title: "x", dueOn: "2026-10-17" }, { anchor })).toBe("high")
    expect(inferPriority({ title: "x", dueOn: "2026-10-15" }, { anchor })).toBe("high")
    expect(inferPriority({ title: "x", dueOn: "2026-10-18" }, { anchor })).toBe("normal")
    expect(inferPriority({ title: "x", dueOn: "2026-10-14" }, { anchor })).toBe("urgent")
  })

  it("never lowers the model priority", () => {
    expect(inferPriority({ title: "x", priority: "urgent", dueOn: "2026-12-01" }, { anchor })).toBe("urgent")
  })

  it("scans the explicit text when given", () => {
    expect(inferPriority({ title: "x" }, { anchor, text: "זה קריטי" })).toBe("high")
  })
})
