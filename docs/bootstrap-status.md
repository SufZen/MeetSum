# MeetSum Bootstrap Status

Last updated: 2026-04-23

## GitHub

- Repository: `SufZen/MeetSum`
- GitHub CLI installed: yes
- GitHub CLI authenticated account: `SufZen`
- Local git protocol: HTTPS

## Google Cloud

- Active account: `info@realization.co.il`
- Project ID: `meetsum-494211`
- Project number: `91554489040`
- Project name: `MeetSum`
- Parent organization ID: `185503707905`

### Enabled APIs

- Admin SDK API: `admin.googleapis.com`
- Calendar API: `calendar-json.googleapis.com`
- Drive API: `drive.googleapis.com`
- Gmail API: `gmail.googleapis.com`
- IAM API: `iam.googleapis.com`
- IAM Credentials API: `iamcredentials.googleapis.com`
- Pub/Sub API: `pubsub.googleapis.com`
- Organization Policy API: `orgpolicy.googleapis.com`
- Cloud Resource Manager API: `cloudresourcemanager.googleapis.com`

### Service Account

- Email: `meetsum-workspace-sync@meetsum-494211.iam.gserviceaccount.com`
- OAuth2 client ID / unique ID: `114094907385707784417`
- Purpose: Workspace domain-wide delegation identity for Calendar, Gmail, Drive, and Admin SDK sync.

Assigned project roles:

- `roles/pubsub.viewer`
- `roles/pubsub.subscriber`
- `roles/serviceusage.serviceUsageConsumer`

### Pub/Sub

- Gmail watch topic: `projects/meetsum-494211/topics/meetsum-gmail-watch`
- Subscription: `projects/meetsum-494211/subscriptions/meetsum-gmail-watch-sub`

### Blockers

- Secret Manager API could not be enabled because the project is not linked to billing.
- Both visible billing accounts returned quota errors when trying to link this project:
  - `013178-3527EF-7CB14D`
  - `01BE94-5A8FB9-FD05D1`
- Gmail push publisher binding is blocked by org policy `constraints/iam.allowedPolicyMemberDomains`.
  - Effective allowed customer ID: `C04d02lbn`
  - Blocked member: `serviceAccount:gmail-api-push@system.gserviceaccount.com`
  - Impact: Gmail push notifications cannot publish to `meetsum-gmail-watch` until this policy allows the Google Gmail push service account or an approved exception path is chosen.

## Required Manual Admin Action

Authorize domain-wide delegation in Google Admin Console for OAuth client ID:

```text
114094907385707784417
```

Scopes to authorize:

```text
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/calendar.events.readonly
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/drive.readonly
https://www.googleapis.com/auth/drive.metadata.readonly
https://www.googleapis.com/auth/admin.directory.user.readonly
https://www.googleapis.com/auth/admin.directory.group.readonly
```

## VPS Initial Inventory

- SSH target: `root@37.27.182.247`
- First SSH probe succeeded, then later SSH attempts timed out on port `22`.
- Web ports `80` and `443` remained reachable from this machine.
- Hostname from successful probe: `sufzen`
- OS kernel: Ubuntu Linux `6.8.0-106-generic`

Detected containers from successful probe:

- `coolify`
- `coolify-proxy`
- `coolify-db`
- `coolify-redis`
- `coolify-realtime`
- `coolify-sentinel`
- `n8n`
- `uptime-kuma`
- `litellm-gateway`
- `openclaw-gateway`
- `smart-router`

Detected system services:

- `realizeos-api.service`
- `cli-agent-bot.service`
- `realizeos-paulo.service`
- `realizeos-sufz.service`
- `docker.service`
- `nginx.service`
- `tailscaled.service`

Detected relevant directories:

- `/opt/realizeos`
- `/opt/openclaw`
- `/opt/n8n`
- `/opt/n8n-automations`
- `/opt/litellm`
- `/opt/smart-router`
- `/opt/suf-zen`

## Next Technical Steps

1. Resolve Google billing quota/linking so Secret Manager and future paid APIs can be enabled.
2. Decide how to handle Gmail Pub/Sub publisher org-policy exception.
3. Complete Google Admin domain-wide delegation authorization.
4. Re-test SSH stability and inspect VPS compose files without exposing `.env` secrets.
5. Build Phase 1: Postgres persistence, auth, API-key auth, migrations, and integration tests.
