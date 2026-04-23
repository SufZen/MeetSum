#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? "meetsum-494211"
const serviceAccount =
  process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT ??
  "meetsum-workspace-sync@meetsum-494211.iam.gserviceaccount.com"
const subject =
  process.env.GOOGLE_WORKSPACE_SUBJECT ?? "info@realization.co.il"
const gcloud =
  process.env.GCLOUD_BIN ??
  (process.platform === "win32"
    ? join(
        process.env.LOCALAPPDATA ?? "",
        "Google",
        "Cloud SDK",
        "google-cloud-sdk",
        "bin",
        "gcloud.cmd",
      )
    : "gcloud")

const scopes = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.directory.group.readonly",
]

function quoteCommandPart(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function runGcloud(args) {
  if (process.platform !== "win32") {
    execFileSync(gcloud, args, { stdio: "ignore" })
    return
  }

  const command = ["&", quoteCommandPart(gcloud), ...args.map(quoteCommandPart)].join(
    " ",
  )
  execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
    stdio: "pipe",
  })
}

async function getDelegatedAccessToken() {
  const tempDir = mkdtempSync(join(tmpdir(), "meetsum-delegation-"))
  const payloadPath = join(tempDir, "payload.json")
  const signedJwtPath = join(tempDir, "signed.jwt")

  try {
    const now = Math.floor(Date.now() / 1000)
    writeFileSync(
      payloadPath,
      JSON.stringify({
        iss: serviceAccount,
        scope: scopes.join(" "),
        aud: "https://oauth2.googleapis.com/token",
        exp: now + 3600,
        iat: now,
        sub: subject,
      }),
    )

    runGcloud([
        "iam",
        "service-accounts",
        "sign-jwt",
        payloadPath,
        signedJwtPath,
        `--iam-account=${serviceAccount}`,
        `--project=${projectId}`,
      ])

    const assertion = readFileSync(signedJwtPath, "utf8").trim()
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    })
    const token = await tokenResponse.json()

    if (!tokenResponse.ok) {
      throw new Error(
        `Delegated token request failed: ${token.error} ${token.error_description ?? ""}`,
      )
    }

    return token.access_token
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

async function requestJson(accessToken, url) {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  })
  const data = await response.json()

  return {
    ok: response.ok,
    status: response.status,
    data,
  }
}

function summarizeResult(name, result) {
  if (result.ok) {
    return { name, ok: true, status: result.status }
  }

  return {
    name,
    ok: false,
    status: result.status,
    error: result.data.error?.message ?? result.data.error_description ?? "Unknown error",
  }
}

const accessToken = await getDelegatedAccessToken()

const checks = [
  [
    "calendar",
    "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1",
  ],
  [
    "drive",
    "https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id,name,mimeType)",
  ],
  ["gmail", "https://gmail.googleapis.com/gmail/v1/users/me/profile"],
  [
    "admin-users",
    `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(
      subject,
    )}?projection=basic`,
  ],
]

const results = []
for (const [name, url] of checks) {
  results.push(summarizeResult(name, await requestJson(accessToken, url)))
}

console.log(JSON.stringify({ subject, serviceAccount, results }, null, 2))
