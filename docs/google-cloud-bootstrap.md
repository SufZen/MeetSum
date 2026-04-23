# Google Cloud Bootstrap

## Recommended Local Tooling

Use Google Cloud CLI (`gcloud`) as the primary setup tool. Google also has official MCP support for some Google/Google Cloud services, but project bootstrap still works best through `gcloud` because it is explicit, auditable, and scriptable.

## Install

On Windows, install Google Cloud CLI from the official installer or with a package manager. After install:

```powershell
gcloud --version
gcloud auth login
gcloud auth application-default login
gcloud config set project meetsum-494211
gcloud config set account info@realization.co.il
```

## Enable APIs

```powershell
gcloud services enable calendar-json.googleapis.com
gcloud services enable gmail.googleapis.com
gcloud services enable drive.googleapis.com
gcloud services enable admin.googleapis.com
gcloud services enable pubsub.googleapis.com
gcloud services enable iam.googleapis.com
gcloud services enable secretmanager.googleapis.com
gcloud services enable cloudresourcemanager.googleapis.com
```

Current status is tracked in `docs/bootstrap-status.md`.

## Create Service Account

```powershell
gcloud iam service-accounts create meetsum-workspace-sync `
  --display-name="MeetSum Workspace Sync"

gcloud iam service-accounts describe `
  meetsum-workspace-sync@meetsum-494211.iam.gserviceaccount.com
```

Enable domain-wide delegation for this service account in Google Cloud Console, then authorize the client ID in Google Admin Console using the scope groups documented in `lib/google/workspace.ts`.

V1 uses Gmail polling. Gmail Pub/Sub push is intentionally deferred because the Workspace organization policy blocks the Google Gmail push publisher service account.

Delegation can be verified locally without creating a service-account JSON key:

```powershell
node scripts/test-google-delegation.mjs
```

The script uses `gcloud iam service-accounts sign-jwt` and never writes a reusable private key.

## Secrets

Do not commit service-account JSON or private keys. For local development, prefer `.env.local`. For production, use the VPS secret manager approach we decide during deployment hardening.
