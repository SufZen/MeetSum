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
- Secret Manager API: `secretmanager.googleapis.com`

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

### Resolved

- Billing is enabled on `billingAccounts/014429-7C26AF-C31224`.
- Secret Manager API is enabled.
- Domain-wide delegation is verified end-to-end using keyless `sign-jwt` impersonation as `info@realization.co.il`.
  - Calendar read probe: passed.
  - Drive read probe: passed.
  - Gmail profile probe: passed.
  - Admin Directory user probe: passed.
- Service-account key creation is blocked by organization policy, and that is acceptable. MeetSum should use keyless service-account signing or VPS-managed secrets instead of downloaded JSON keys.

### Decisions

- Gmail V1 will use polling instead of Pub/Sub push.
- Gmail push publisher binding is blocked by org policy `constraints/iam.allowedPolicyMemberDomains`, so push notifications are deferred.
  - Effective allowed customer ID: `C04d02lbn`
  - Blocked member: `serviceAccount:gmail-api-push@system.gserviceaccount.com`
  - Impact: Gmail context can lag by the polling interval in V1.

## Required Manual Admin Action

Domain-wide delegation was authorized in Google Admin Console for OAuth client ID:

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

1. Re-test SSH stability and inspect VPS compose files without exposing `.env` secrets.
2. Build Phase 1: Postgres persistence, auth, API-key auth, migrations, and integration tests.
