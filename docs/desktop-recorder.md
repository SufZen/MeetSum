# MeetSum Capture Desktop Companion

MeetSum Capture is a small Electron companion for local desktop capture. It records microphone plus computer audio locally, stores an offline spool, and uploads recordings to MeetSum through the desktop ingestion API.

## Run Locally

```bash
npm run desktop:dev
```

The app stores local config, media, and spool manifests in Electron's user data directory. Use **Open data folder** inside the app to inspect that folder.

## Build A Windows Installer

```bash
npm run desktop:dist:win
```

This creates:

- `desktop-recorder/release/MeetSum-Capture-Setup-0.6.0-x64.exe` — normal Windows installer with Start menu and desktop shortcuts.
- `desktop-recorder/release/MeetSum-Capture-0.6.0-x64.exe` — portable app for quick testing without installation.

The repository also includes a **Desktop Windows Installer** GitHub Actions workflow. Run it manually or open a PR that changes desktop files, then download the `meetsum-capture-windows` artifact from the workflow run.

## Code Signing

Windows installers are signed automatically in GitHub Actions when these repository secrets are configured:

- `WIN_CSC_LINK` — Windows code-signing certificate path or base64-encoded certificate, as supported by electron-builder.
- `WIN_CSC_KEY_PASSWORD` — password for the certificate.

Electron Builder also falls back to `CSC_LINK` and `CSC_KEY_PASSWORD`, but the workflow uses the Windows-specific names so future macOS signing can use separate credentials.

After `npm run desktop:dist:win`, verify local signed artifacts with:

```powershell
Get-AuthenticodeSignature desktop-recorder\release\MeetSum-Capture-Setup-0.6.0-x64.exe
Get-AuthenticodeSignature desktop-recorder\release\MeetSum-Capture-0.6.0-x64.exe
```

The workflow runs `scripts/verify-windows-signature.ps1` automatically when `WIN_CSC_LINK` is present. If signing secrets are not configured, GitHub Actions still builds unsigned artifacts for PR smoke testing. Unsigned builds may trigger Windows SmartScreen until a trusted certificate and reputation are in place.

## Connection

Configure:

- MeetSum URL, for example `https://meetsum.example.com`
- API key with access to MeetSum
- Default language: `mixed`, `he`, or `en`

For the VPS, make sure:

- `MEETSUM_REQUIRE_API_KEY=true` is enabled.
- The API key entered in the desktop app is present in `MEETSUM_API_KEYS`, `MEETSUM_API_KEY_HASHES`, or the API-key management table.
- Object storage is configured because desktop uploads store media privately before worker processing.
- The worker is running so uploaded media can enter the normal transcription, summary, tasks, index, webhook, export, and RealizeOS flow.

Uploads call:

```text
POST /api/desktop-capture/ingest
Authorization: Bearer <api-key>
```

## Capture Flow

1. Pick a microphone.
2. Pick a desktop/window source for system audio.
3. Start recording.
4. Stop to write a local `.webm` media file plus a JSON manifest.
5. Upload from the offline spool.

The renderer mixes microphone and system audio with Web Audio at a 48 kHz target, applies a compressor for clipping protection, and writes an Opus/WebM capture. The manifest includes a stable `captureId`, device names, sample rate, duration, app version, platform, and upload status.

## Retry Behavior

Each capture keeps a stable `captureId`. If an upload fails, the spool marks the capture as `failed` and later retries with `uploadStatus: "retry"`. MeetSum uses `captureMetadata.captureId` to reuse an existing `desktop_capture` media asset instead of storing a duplicate.

## Current Boundaries

- MeetSum remains the system of record for meetings, transcripts, summaries, search, exports, webhooks, RealizeOS, and Google Workspace sync.
- Local transcription is represented in the API contract and metadata, but this companion does not bundle Whisper or Parakeet yet.
- Auto-update and macOS permission polishing are still release tasks.
