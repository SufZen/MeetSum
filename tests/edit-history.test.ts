import { describe, expect, it } from "vitest"

import {
  createEditHistory,
  forgetSegment,
  peekEdit,
  popEdit,
  pushEdit,
} from "@/lib/player/edit-history"

describe("edit history", () => {
  it("pushes and pops in LIFO order", () => {
    let history = createEditHistory()

    history = pushEdit(history, { segmentId: "a", revision: 1, kind: "text" })
    history = pushEdit(history, { segmentId: "b", revision: 3, kind: "speaker" })
    expect(peekEdit(history)?.segmentId).toBe("b")

    const first = popEdit(history)

    expect(first.entry).toEqual({ segmentId: "b", revision: 3, kind: "speaker" })
    expect(popEdit(first.history).entry?.segmentId).toBe("a")
  })

  it("supersedes an older entry for the same segment", () => {
    let history = createEditHistory()

    history = pushEdit(history, { segmentId: "a", revision: 1, kind: "text" })
    history = pushEdit(history, { segmentId: "b", revision: 1, kind: "text" })
    history = pushEdit(history, { segmentId: "a", revision: 2, kind: "text" })

    expect(history.entries.map((entry) => `${entry.segmentId}@${entry.revision}`)).toEqual(["b@1", "a@2"])
  })

  it("caps the stack", () => {
    let history = createEditHistory(2)

    for (const id of ["a", "b", "c"]) history = pushEdit(history, { segmentId: id, revision: 1, kind: "text" })

    expect(history.entries.map((entry) => entry.segmentId)).toEqual(["b", "c"])
  })

  it("pops nothing from an empty stack and forgets stale segments", () => {
    const empty = createEditHistory()

    expect(popEdit(empty)).toEqual({ history: empty })

    const history = pushEdit(empty, { segmentId: "a", revision: 1, kind: "text" })

    expect(forgetSegment(history, "a").entries).toEqual([])
    expect(forgetSegment(history, "zzz")).toBe(history)
  })
})
