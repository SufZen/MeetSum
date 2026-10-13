import { describe, expect, it } from "vitest"

import {
  filterMemberMentions,
  mentionMarkup,
  parseMentions,
  sanitizeMentions,
  splitMentions,
} from "@/lib/comments/mentions"

/** M5 C3 `@[name](user:<id>)` mentions: parse, member filter, strip, split. */

describe("mentions", () => {
  it("parses mentions in order, deduplicated by user id", () => {
    expect(
      parseMentions("היי @[דנה כהן](user:usr_1) ו-@[Avi](user:usr_2), שוב @[Dana](user:usr_1)")
    ).toEqual([
      { userId: "usr_1", name: "דנה כהן" },
      { userId: "usr_2", name: "Avi" },
    ])
  })

  it("ignores malformed markup", () => {
    expect(parseMentions("@[x](user:) @[](user:usr_1) @[a](usr_1) @[b](user:../x)")).toEqual([])
  })

  it("keeps only workspace members", () => {
    const mentions = parseMentions("@[A](user:usr_1) @[B](user:usr_x)")

    expect(filterMemberMentions(mentions, new Set(["usr_1"]))).toEqual([{ userId: "usr_1", name: "A" }])
  })

  it("turns non-member mentions into plain text", () => {
    expect(sanitizeMentions("@[Dana](user:usr_1) ping @[Eve](user:usr_evil)", new Set(["usr_1"]))).toEqual({
      body: "@[Dana](user:usr_1) ping @Eve",
      mentions: ["usr_1"],
    })
  })

  it("splits a body into text and mention parts", () => {
    expect(splitMentions("שלום @[דנה](user:usr_1)!")).toEqual([
      { type: "text", text: "שלום " },
      { type: "mention", name: "דנה", userId: "usr_1" },
      { type: "text", text: "!" },
    ])
  })

  it("builds safe markup for a picked member", () => {
    expect(mentionMarkup("Dana [admin] (x)", "usr_1")).toBe("@[Dana admin x](user:usr_1)")
    expect(parseMentions(mentionMarkup("דנה", "usr_9"))).toEqual([{ userId: "usr_9", name: "דנה" }])
  })
})
