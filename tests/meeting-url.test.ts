import { describe, expect, it } from "vitest"

import {
  diagnoseMeetingLink,
  extractMeetingLinks,
  meetingLinkSecrets,
  parseMeetingLink,
  rebuildCanonicalUrl,
} from "@/lib/bot/meeting-url"

const RLM = "‏"
const THREAD = "19:meeting_NjY4YzEzMzQtZjBkZS00OTk1LWE4ZjAtMTIzNDU2Nzg5MDEy@thread.v2"
const TEAMS_JOIN =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjY4YzEzMzQtZjBkZS00OTk1LWE4ZjAtMTIzNDU2Nzg5MDEy%40thread.v2/0" +
  '?context={"Tid":"72f988bf-86f1-41af-91ab-2d7cd011db47","Oid":"a1b2c3d4-0000-1111-2222-333344445555"}'

describe("parseMeetingLink table (docs/parity/m7.md)", () => {
  it.each([
    ["1 plain Meet", "https://meet.google.com/abc-defg-hij", "abc-defg-hij"],
    ["2 uppercase, no scheme, query", "MEET.GOOGLE.COM/ABC-DEFG-HIJ?authuser=1", "abc-defg-hij"],
    ["3 Hebrew label glued, trailing dot", "קישור לפגישה:https://meet.google.com/abc-defg-hij.", "abc-defg-hij"],
    ["4 RLM on both sides", `${RLM}https://meet.google.com/abc-defg-hij${RLM}`, "abc-defg-hij"],
    ["14 Hebrew gershayim", "״https://meet.google.com/abc-defg-hij״", "abc-defg-hij"],
  ])("row %s", (_row, input, id) => {
    const link = parseMeetingLink(input)

    expect(link).toMatchObject({
      platform: "google_meet",
      nativeMeetingId: id,
      canonicalUrl: `https://meet.google.com/${id}`,
      redactedUrl: `https://meet.google.com/${id}`,
      source: "input",
    })
    expect(link?.passcode).toBeUndefined()
  })

  it("row 5: Zoom in parentheses inside Hebrew text", () => {
    expect(parseMeetingLink("להצטרפות (https://zoom.us/j/81234567890?pwd=AbC123) תודה")).toEqual({
      platform: "zoom",
      nativeMeetingId: "81234567890",
      passcode: "AbC123",
      canonicalUrl: "https://zoom.us/j/81234567890?pwd=AbC123",
      redactedUrl: "https://zoom.us/j/81234567890",
      source: "input",
    })
  })

  it("row 6: Hebrew glued to the passcode", () => {
    const link = parseMeetingLink("https://acme.zoom.us/j/8123456789?pwd=xyzלהצטרף")

    expect(link).toMatchObject({ platform: "zoom", nativeMeetingId: "8123456789", passcode: "xyz" })
    expect(link?.canonicalUrl).toBe("https://acme.zoom.us/j/8123456789?pwd=xyz")
  })

  it("row 7: Zoom personal link is unsupported", () => {
    expect(parseMeetingLink("https://zoom.us/my/dana")).toBeUndefined()
    expect(diagnoseMeetingLink("https://zoom.us/my/dana")).toBe("personal_link")
  })

  it("row 8: Teams meetup-join decodes the thread, keeps context only canonically", () => {
    const link = parseMeetingLink(`הזמנה לפגישה: ${TEAMS_JOIN} נתראה`)

    expect(link?.platform).toBe("teams")
    expect(link?.nativeMeetingId).toBe(THREAD)
    expect(link?.teamsBaseHost).toBeUndefined()
    expect(decodeURIComponent(link?.canonicalUrl ?? "")).toContain('"Tid":"72f988bf-86f1-41af-91ab-2d7cd011db47"')
    expect(link?.redactedUrl).toBe(
      `https://teams.microsoft.com/l/meetup-join/${encodeURIComponent(THREAD)}/0`
    )
    expect(link?.redactedUrl).not.toContain("context")
  })

  it("row 8b: percent-encoded context", () => {
    const encoded = TEAMS_JOIN.replace(/\?context=(.*)$/, (_m, context: string) => `?context=${encodeURIComponent(context)}`)
    const link = parseMeetingLink(encoded)

    expect(link?.nativeMeetingId).toBe(THREAD)
    expect(new URL(link!.canonicalUrl).searchParams.get("context")).toContain("72f988bf")
  })

  it("row 9: teams.live.com numeric with passcode and base host", () => {
    expect(parseMeetingLink("https://teams.live.com/meet/9384756123456?p=Qw12")).toEqual({
      platform: "teams",
      nativeMeetingId: "9384756123456",
      passcode: "Qw12",
      teamsBaseHost: "teams.live.com",
      canonicalUrl: "https://teams.live.com/meet/9384756123456?p=Qw12",
      redactedUrl: "https://teams.live.com/meet/9384756123456",
      source: "input",
    })
  })

  it("row 10: teams.microsoft.com numeric", () => {
    const link = parseMeetingLink("https://teams.microsoft.com/meet/312345678901?p=x")

    expect(link).toMatchObject({ platform: "teams", nativeMeetingId: "312345678901", passcode: "x" })
    expect(link?.teamsBaseHost).toBeUndefined()
  })

  it("GCC and DoD hosts set teamsBaseHost", () => {
    expect(parseMeetingLink("https://gov.teams.microsoft.us/meet/312345678901?p=x")?.teamsBaseHost).toBe(
      "gov.teams.microsoft.us"
    )
    expect(parseMeetingLink("https://dod.teams.microsoft.us/meet/312345678901")?.teamsBaseHost).toBe(
      "dod.teams.microsoft.us"
    )
  })

  it("row 11: safelinks-wrapped Teams link", () => {
    const wrapped = `https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent(
      "https://teams.microsoft.com/meet/312345678901?p=Zz9"
    )}&data=05%7C02&reserved=0`
    const link = parseMeetingLink(`לחצו כאן ${wrapped}`)

    expect(link).toMatchObject({ platform: "teams", nativeMeetingId: "312345678901", passcode: "Zz9" })
  })

  it("row 11b: safelinks-wrapped meetup-join (double-encoded thread)", () => {
    const wrapped = `https://nam12.safelinks.protection.outlook.com/?url=${encodeURIComponent(TEAMS_JOIN)}&data=x`

    expect(parseMeetingLink(wrapped)?.nativeMeetingId).toBe(THREAD)
  })

  it("row 12: google.com/url-wrapped Meet link", () => {
    const link = parseMeetingLink(
      "https://www.google.com/url?q=https://meet.google.com/abc-defg-hij&sa=D&source=calendar&usg=AOvVaw0"
    )

    expect(link).toMatchObject({ platform: "google_meet", nativeMeetingId: "abc-defg-hij" })
  })

  it("urldefense v3 wrapper", () => {
    const link = parseMeetingLink(
      "https://urldefense.com/v3/__https://zoom.us/j/81234567890?pwd=q1w2__;!!abc$"
    )

    expect(link).toMatchObject({ platform: "zoom", nativeMeetingId: "81234567890", passcode: "q1w2" })
  })

  it("row 13: &amp; inside an HTML description", () => {
    const link = parseMeetingLink(
      '<p>Join: <a href="https://zoom.us/j/81234567890?pwd=a&amp;x=1">Zoom</a></p>',
      "description"
    )

    expect(link).toMatchObject({ platform: "zoom", passcode: "a", source: "description" })
  })

  it("entity-encoded slashes", () => {
    expect(parseMeetingLink("https:&#x2F;&#x2F;meet.google.com&#x2F;abc-defg-hij")?.nativeMeetingId).toBe(
      "abc-defg-hij"
    )
  })

  it("fullwidth characters are NFKC-mapped", () => {
    expect(parseMeetingLink("ｈｔｔｐｓ://meet.google.com/abc-defg-hij")?.nativeMeetingId).toBe("abc-defg-hij")
  })

  it.each([
    ["15 host in path", "https://evil.example/meet.google.com/abc-defg-hij"],
    ["16 lookalike host", "https://meet.google.com.evil.io/abc-defg-hij"],
    ["17 javascript", "javascript:alert('https://meet.google.com/abc-defg-hij')".replace("https://", "")],
    ["17 tel", "tel:+972-3-555-1234"],
    ["Meet lookup", "https://meet.google.com/lookup/abcdef"],
    ["bad Meet id", "https://meet.google.com/abcdefghij"],
    ["credentials", "https://user:pass@meet.google.com/abc-defg-hij"],
    ["port", "https://meet.google.com:8443/abc-defg-hij"],
    ["short zoom id", "https://zoom.us/j/1234"],
  ])("row %s yields nothing", (_row, input) => {
    expect(parseMeetingLink(input)).toBeUndefined()
  })

  it("diagnoses rejections", () => {
    expect(diagnoseMeetingLink("hello")).toBe("no_link")
    expect(diagnoseMeetingLink("https://evil.example/x")).toBe("unsupported_host")
    expect(diagnoseMeetingLink("https://meet.google.com/lookup/abc")).toBe("lookup_link")
    expect(diagnoseMeetingLink("https://u:p@zoom.us/j/81234567890")).toBe("credentials_in_url")
  })

  it("row 18: a 5 KB input is rejected", () => {
    const input = `https://meet.google.com/abc-defg-hij ${"א".repeat(5 * 1024)}`

    expect(parseMeetingLink(input)).toBeUndefined()
    expect(extractMeetingLinks(input)).toEqual([])
    expect(diagnoseMeetingLink(input)).toBe("too_long")
  })

  it("calendar descriptions get a larger budget", () => {
    const description = `${"<p>פרטים</p>".repeat(600)} https://meet.google.com/abc-defg-hij`

    expect(description.length).toBeGreaterThan(4096)
    expect(parseMeetingLink(description, "description")?.nativeMeetingId).toBe("abc-defg-hij")
  })

  it("row 19: two links, ordered and de-duplicated", () => {
    const links = extractMeetingLinks(
      "ראשון https://zoom.us/j/81234567890?pwd=a, שני https://meet.google.com/abc-defg-hij " +
        "ושוב https://us02web.zoom.us/j/81234567890 https://meet.google.com/abc-defg-hij?authuser=0"
    )

    expect(links.map((link) => [link.platform, link.nativeMeetingId])).toEqual([
      ["zoom", "81234567890"],
      ["google_meet", "abc-defg-hij"],
    ])
  })

  it("comma-glued links in one run", () => {
    const links = extractMeetingLinks("https://meet.google.com/abc-defg-hij,https://zoom.us/j/81234567890")

    expect(links.map((link) => link.platform)).toEqual(["google_meet", "zoom"])
  })

  it("row 20: http is upgraded to https", () => {
    expect(parseMeetingLink("http://meet.google.com/abc-defg-hij")?.canonicalUrl).toBe(
      "https://meet.google.com/abc-defg-hij"
    )
  })

  it("Zoom web-client paths", () => {
    expect(parseMeetingLink("https://zoom.us/wc/join/81234567890")?.nativeMeetingId).toBe("81234567890")
    expect(parseMeetingLink("https://zoom.us/wc/81234567890/join?pwd=k")?.passcode).toBe("k")
    expect(parseMeetingLink("https://zoomgov.com/w/81234567890")?.platform).toBe("zoom")
    expect(parseMeetingLink("https://zoom.com/s/81234567890")?.platform).toBe("zoom")
  })

  it("balanced parentheses are kept, unbalanced trimmed", () => {
    expect(parseMeetingLink("(see https://meet.google.com/abc-defg-hij)!")?.nativeMeetingId).toBe("abc-defg-hij")
  })
})

describe("linear-time extraction (ReDoS)", () => {
  const pathological: Array<[string, string]> = [
    ["repeated zoom fragments", "https://zoom.us/j/".repeat(2800)],
    ["a. runs", "a.".repeat(25_000)],
    ["a. runs with a slash", `${"a.".repeat(25_000)}/x`],
    ["dash runs", "-".repeat(50_000)],
    ["dot-dash mix", "a.-".repeat(17_000)],
    ["unbalanced closers", `https://meet.google.com/abc-defg-hij${")".repeat(50_000)}`],
    ["unclosed tags", "<a href=\"x ".repeat(5_000)],
    ["unclosed hrefs", "href=\"".repeat(9_000)],
    ["nested wrappers", "https://www.google.com/url?q=".repeat(1_800)],
    ["urldefense markers", "https://urldefense.com/v3/__".repeat(1_800)],
    ["entities", "&#x2F;".repeat(9_000)],
    ["scheme soup", "http:/https:/http://".repeat(2_600)],
  ]

  it.each(pathological)("%s completes quickly", (_label, text) => {
    expect(text.length).toBeGreaterThanOrEqual(45_000)

    for (const source of ["description", "location"] as const) {
      const started = performance.now()

      extractMeetingLinks(text, source)
      parseMeetingLink(text, source)
      expect(performance.now() - started).toBeLessThan(50)
    }

    const started = performance.now()

    diagnoseMeetingLink(text.slice(0, 4096))
    extractMeetingLinks(text.slice(0, 4096))
    expect(performance.now() - started).toBeLessThan(50)
  })

  it("caps the number of candidates and links", () => {
    const many = Array.from({ length: 200 }, (_, index) => `https://zoom.us/j/${81234500000 + index}`).join(" ")

    expect(extractMeetingLinks(many, "description").length).toBeLessThanOrEqual(20)
  })

  it("scans only the first 20,000 characters of calendar text", () => {
    const late = `${"x ".repeat(10_001)}https://meet.google.com/abc-defg-hij`

    expect(extractMeetingLinks(late, "description")).toEqual([])
    expect(extractMeetingLinks(`https://meet.google.com/abc-defg-hij ${late}`, "description")).toHaveLength(1)
  })
})

describe("secrets round-trip", () => {
  it("rebuilds canonical URLs from the redacted URL and sealed secrets", () => {
    const zoom = parseMeetingLink("https://acme.zoom.us/j/81234567890?pwd=AbC123")!

    expect(rebuildCanonicalUrl("zoom", zoom.redactedUrl, meetingLinkSecrets(zoom))).toBe(zoom.canonicalUrl)

    const teams = parseMeetingLink(TEAMS_JOIN)!
    const rebuilt = rebuildCanonicalUrl("teams", teams.redactedUrl, meetingLinkSecrets(teams))!

    expect(new URL(rebuilt).searchParams.get("context")).toBe(new URL(teams.canonicalUrl).searchParams.get("context"))

    const numeric = parseMeetingLink("https://teams.live.com/meet/9384756123456?p=Qw12")!

    expect(rebuildCanonicalUrl("teams", numeric.redactedUrl, meetingLinkSecrets(numeric))).toBe(numeric.canonicalUrl)
  })

  it("refuses non-allowlisted or mismatched URLs", () => {
    expect(rebuildCanonicalUrl("zoom", "https://evil.example/j/81234567890")).toBeUndefined()
    expect(rebuildCanonicalUrl("teams", "https://meet.google.com/abc-defg-hij")).toBeUndefined()
    expect(rebuildCanonicalUrl("zoom", null)).toBeUndefined()
  })
})
