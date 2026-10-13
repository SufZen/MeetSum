import { describe, expect, it } from "vitest"

import type { AliasMap } from "@/lib/ask/citations"
import { enforceCitations, isFramingSentence, splitSentences } from "@/lib/ask/claims"

/** "No citation, no claim" (docs/parity/m6.md, C4 tests). */

const aliases: AliasMap = {
  s1: { alias: "s1", meetingId: "m1", meetingTitle: "סקירת תקציב", segmentId: "seg_1", startMs: 0, kind: "transcript", speakerName: "דנה", quote: "q" },
  s2: { alias: "s2", meetingId: "m1", meetingTitle: "סקירת תקציב", segmentId: "seg_2", startMs: 1, kind: "transcript", quote: "q" },
  a1: { alias: "a1", meetingId: "m1", meetingTitle: "סקירת תקציב", kind: "item", quote: "q" },
}

describe("splitSentences", () => {
  it("splits Hebrew sentences and keeps trailing markers with their sentence", () => {
    expect(splitSentences("התקציב אושר. [s1] הגיוס נדחה לרבעון הבא [s2]. מה עם השיווק?")).toEqual([
      "התקציב אושר. [s1]",
      "הגיוס נדחה לרבעון הבא [s2].",
      "מה עם השיווק?",
    ])
  })

  it("keeps decimals, abbreviations and initials together", () => {
    expect(splitSentences("The budget grew 3.5 percent, e.g. for Q3 [s1]. Dr. Cohen agreed [s2].")).toEqual([
      "The budget grew 3.5 percent, e.g. for Q3 [s1].",
      "Dr. Cohen agreed [s2].",
    ])
    expect(splitSentences("J. Smith said so [s1].")).toEqual(["J. Smith said so [s1]."])
  })

  it("handles closing quotes and ellipses", () => {
    expect(splitSentences('הוא אמר "נמשיך". [s1] ואז… השתתק [s2]')).toEqual(['הוא אמר "נמשיך". [s1]', "ואז… השתתק [s2]"])
  })
})

describe("enforceCitations", () => {
  it("drops uncited sentences in strict mode and counts them", () => {
    const result = enforceCitations("התקציב אושר [s1]. ההנהלה מרוצה מאוד מהתוצאות של השנה הזאת בכל המדדים. הגיוס נדחה [s2].", aliases, {
      strict: true,
    })

    expect(result.content).toBe("התקציב אושר [s1]. הגיוס נדחה [s2].")
    expect(result.droppedUncitedSentences).toBe(1)
    expect(result.citedSentences).toBe(2)
  })

  it("keeps one short leading framing sentence", () => {
    const result = enforceCitations("לפי הפגישות האחרונות:\n- התקציב אושר [s1]\n- סתם טענה", aliases, { strict: true })

    expect(result.content).toBe("לפי הפגישות האחרונות:\n- התקציב אושר [s1]")
    expect(result.droppedUncitedSentences).toBe(1)
  })

  it("does not treat a leading sentence with digits, names or quotes as framing", () => {
    expect(isFramingSentence("לפי הפגישות האחרונות:")).toBe(true)
    expect(isFramingSentence("התקציב הוא 5 מיליון.")).toBe(false)
    expect(isFramingSentence("דנה סיכמה את הדיון.", ["דנה"])).toBe(false)
    expect(isFramingSentence('הוחלט "לא להמשיך".')).toBe(false)
    expect(isFramingSentence("In the meeting Dana agreed.")).toBe(false)
    expect(isFramingSentence("Here is what the meetings say:")).toBe(true)
    expect(isFramingSentence("זה משפט ארוך מדי עם הרבה יותר משתים עשרה מילים שלא אמור להיחשב כמשפט פתיחה בכלל")).toBe(false)
  })

  it("returns nothing (-> refusal) when no sentence is cited", () => {
    const result = enforceCitations("לפי הפגישות האחרונות: הכול טוב. הכול מצוין.", aliases, { strict: true })

    expect(result.citedSentences).toBe(0)
  })

  it("does not count unknown aliases as citations", () => {
    const result = enforceCitations("התקציב אושר [s9]. הגיוס נדחה [s2].", aliases, { strict: true })

    expect(result.content).toBe("הגיוס נדחה [s2].")
  })

  it("keeps everything when strict mode is off", () => {
    const result = enforceCitations("טענה ראשונה. טענה שנייה [s1].", aliases, { strict: false })

    expect(result.content).toBe("טענה ראשונה. טענה שנייה [s1].")
    expect(result.droppedUncitedSentences).toBe(0)
  })

  it("keeps paragraph breaks between kept lines", () => {
    const result = enforceCitations("א [s1].\n\n\n\nב [a1].", aliases, { strict: true })

    expect(result.content).toBe("א [s1].\n\nב [a1].")
  })
})
