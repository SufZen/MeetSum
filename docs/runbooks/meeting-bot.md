# Meeting bot (M7) — operations and security notes

Operational setup, capacity and the troubleshooting table live in [vexa.md](vexa.md). This page records the security posture of the meeting bot so operators can make an informed deployment decision.

## Docker socket and host isolation

The Vexa runtime starts one headless-browser container per meeting through the Docker Engine API. Whoever can create containers on a Docker daemon controls that host: a container started with `privileged: true`, a bind mount of `/`, `pid: host` or extra capabilities is a host escape.

- **A raw `/var/run/docker.sock` mount is root on the host.**
- **`deploy/vexa/compose.socket-proxy.yml` is NOT a security boundary.** `tecnativa/docker-socket-proxy` filters by API path and HTTP method only. Vexa needs `CONTAINERS=1` and `POST=1` to create and start bot containers, and that combination still accepts a create request with `Privileged`, host binds, devices or host namespaces. The proxy cannot inspect request bodies. It only removes the other API sections (images, networks, volumes, exec, swarm, system, secrets…), so it reduces accidental surface, not the impact of a compromised runtime.
- The proxy is **opt-in** twice: `VEXA_SOCKET_PROXY=1` in `vexa.env` makes `deploy/vexa/bootstrap.sh` add the file and `--profile socket-proxy`. `IMAGES=0` (the bot image is pre-pulled by bootstrap) and `NETWORKS=0` are set; both are unverified against v0.12.28. If bots fail to spawn, enable `IMAGES=1` first (which, with POST, also allows image pulls and deletes), then `NETWORKS=1`.

### Recommended deployment

1. **Run Vexa on an isolated host or VM** (preferred), or under **rootless Docker** so a container escape lands in an unprivileged user.
2. **Keep no MeetSum secrets on the Vexa host.** Only Vexa's own configuration belongs there: its API/admin tokens, the webhook signing secret it shares with MeetSum (`VEXA_WEBHOOK_SECRET`), and the bucket-scoped MinIO key (`VEXA_MINIO_ACCESS_KEY`, created by `vexa-minio-init`, limited to the Vexa recordings bucket). Never `DATABASE_URL`, `MEETSUM_SESSION_SECRET`, `GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY`, `WEBHOOK_SIGNING_SECRET`, OAuth client secrets or MinIO root credentials.
3. Expose only the Vexa gateway to MeetSum, over a private network (`VEXA_API_URL`). Publish no Vexa port publicly and keep it off Traefik.
4. If Vexa must share the MeetSum host, treat a Vexa compromise as a MeetSum host compromise and record that risk acceptance.

The step-by-step setup for the isolated layout (network, firewall rules, what lives on which host, socket-proxy validation) is in [vexa-isolated-host.md](vexa-isolated-host.md).

## Trust boundaries in MeetSum

- **Webhook** (`POST /api/integrations/vexa/webhook`): HMAC-SHA256 over `<timestamp>.<raw body>`, compared in constant time, timestamp tolerance (default 300 s), body capped at 256 KB while streaming (declared `Content-Length` checked first, then actual bytes) before the HMAC and JSON parse, idempotent per event id and per (workspace, Vexa meeting, event, status). The workspace comes only from the stored bot session (`getForWebhook`), never from the payload; unknown meetings are a 200 no-op.
- **Workspace isolation**: every bot session read and write binds `workspace_id`. The only unscoped lookups are named system lookups (`getForWebhook`, the reconcile/dispatch/retention lists); their rows are used with their own workspace. Dispatch jobs load the session by id and workspace and fail unrecoverably on a mismatch. Adopting a running Vexa bot after a 409 is refused if another session owns that Vexa meeting or another workspace has an open session for the same target.
- **APIs**: bot routes resolve meetings through the caller-scoped repository; an invisible meeting (other workspace or private) is a 404. Responses never include a passcode, Teams context or raw meeting URL; link secrets are sealed with `sealMeetingSecrets` at rest.
- **Logs**: bot code logs through `botLog` / `redactBotError`, which strip URL queries, tokens and passcodes. Since M10 `botLog` writes through the pino server logger (`component: "bot"`), which redacts again (see [observability.md](observability.md)).
