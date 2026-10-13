/**
 * Dev/e2e fake Microsoft endpoints (docs/parity/m8.md, "Fake mode"), served by
 * A's `createFakeProviderServer` behind MEETSUM_INTEGRATIONS_FAKE_BASE_URL.
 * Keys are `"<METHOD> <path>"` with the provider origin stripped. Fake tokens
 * only; never used in production (A's boot check refuses fake mode there).
 */
import type { FakeProviderHandlers } from "@/lib/integrations/core/types"

const FAKE_TID = "00000000-0000-4000-8000-00000000fa4e"
const FAKE_OID = "00000000-0000-4000-8000-0000000000e1"

function idToken(): string {
  const payload = Buffer.from(JSON.stringify({ tid: FAKE_TID, oid: FAKE_OID })).toString("base64url")

  return `eyJhbGciOiJub25lIn0.${payload}.`
}

function tokenBody() {
  return {
    token_type: "Bearer",
    scope: "openid profile email offline_access User.Read Calendars.Read",
    expires_in: 3600,
    access_token: `fake-ms-access-${Date.now()}`,
    refresh_token: `fake-ms-refresh-${Date.now()}`,
    id_token: idToken(),
  }
}

function inHours(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString().replace("Z", "0000")
}

/**
 * One upcoming Teams event. Its iCalUID is the one `integrations:e2e-seed`
 * puts on a Google calendar row (`E2E_M8_ICAL_UID`), so the e2e shows that
 * a meeting on both calendars yields one meeting and one bot session.
 */
export const FAKE_OUTLOOK_ICAL_UID = "e2e-m8-shared-event@meetsum.test"

export const microsoftFakeHandlers: FakeProviderHandlers = {
  "GET /organizations/oauth2/v2.0/authorize": (request) => {
    const target = new URL(request.query.redirect_uri ?? "http://127.0.0.1/")

    target.searchParams.set("code", "fake-ms-code")
    target.searchParams.set("state", request.query.state ?? "")
    return { redirect: target.toString() }
  },
  "POST /organizations/oauth2/v2.0/token": () => ({ body: tokenBody() }),
  "GET /v1.0/me": () => ({
    body: { id: FAKE_OID, mail: "member@fake.example", userPrincipalName: "member@fake.example", displayName: "Fake Member" },
  }),
  "GET /v1.0/me/calendarView/delta": () => ({
    body: {
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=fake-delta",
      value: [
        {
          id: "fake-outlook-event-1",
          iCalUId: FAKE_OUTLOOK_ICAL_UID,
          subject: "פגישת לקוח (Outlook)",
          isCancelled: false,
          isAllDay: false,
          sensitivity: "normal",
          start: { dateTime: inHours(2), timeZone: "UTC" },
          end: { dateTime: inHours(3), timeZone: "UTC" },
          organizer: { emailAddress: { name: "Fake Member", address: "member@fake.example" } },
          attendees: [
            { type: "required", status: { response: "none" }, emailAddress: { name: "Client", address: "client@customer.example" } },
          ],
          body: { contentType: "text", content: "" },
          onlineMeeting: {
            joinUrl:
              "https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZmFrZW1lZXRpbmc%40thread.v2/0?context=%7b%22Tid%22%3a%2200000000-0000-4000-8000-00000000fa4e%22%7d",
          },
        },
      ],
    },
  }),
}
