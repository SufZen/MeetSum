# Google Workspace Setup

1. Create a Google Cloud project for the app.
2. Enable Calendar API, Gmail API, Drive API, Admin SDK API, and Pub/Sub.
3. Create a service account and enable domain-wide delegation.
4. In Google Admin Console, authorize the service account client ID with the narrow scopes listed by `GOOGLE_WORKSPACE_SCOPES` in `lib/google/workspace.ts`.
5. Store service account credentials in your VPS secret manager or `.env.local` for development.
6. Configure HTTPS callbacks before enabling Calendar and Drive watch channels.
7. Configure a Pub/Sub topic/subscription for Gmail push notifications.

The first implementation queues sync requests and records the policy surface. Real API calls should be added behind the Google connector module, keeping route handlers unchanged.
