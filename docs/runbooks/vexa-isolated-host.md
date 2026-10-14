# Runbook: Vexa on an isolated host

The Vexa runtime creates one browser container per meeting through the Docker API, and whoever can create containers on a Docker daemon controls that host (see `meeting-bot.md`). The recommended production layout therefore runs Vexa on **its own VM or rootless Docker host** with no MeetSum secrets. The same-host layout in `vexa.md` remains supported for evaluation. Spec: `docs/parity/m10.md` ("Runbooks", R3, R15).

## Topology

```
MeetSum VPS (meetsum project)                         Vexa host (dedicated VM, rootless Docker preferred)
  app, worker ──── private network (WireGuard/Tailscale), TLS ────► vexa gateway :8000
  minio :9000 ◄─── private network, bucket-only key ─────────────── meeting-api (recordings)
  /api/integrations/vexa/webhook ◄── HTTPS (public URL or private) ─ meeting-api (signed webhooks)
```

- MeetSum talks to Vexa only through the gateway: `VEXA_API_URL=https://<vexa-private-name>:8000` (TLS terminated by the gateway's reverse proxy or a sidecar such as Caddy on the Vexa host).
- Vexa writes recordings into MeetSum's MinIO with the **bucket-only** key created by `vexa-minio-init` (`VEXA_MINIO_ACCESS_KEY`/`VEXA_MINIO_SECRET_KEY`, limited to `VEXA_MINIO_BUCKET`).
- Vexa sends status webhooks to MeetSum, HMAC-signed with `VEXA_WEBHOOK_SECRET`.

## Network and firewall

Use a private overlay (WireGuard or Tailscale) between the two hosts. Then allow exactly:

| From | To | Port | Why |
|---|---|---|---|
| MeetSum app, worker | Vexa gateway | 8000/tcp (TLS) | bot requests, status, recordings API |
| Vexa meeting-api | MeetSum MinIO | 9000/tcp | recording uploads (bucket-only key) |
| Vexa meeting-api | MeetSum app | 443/tcp (or the private app port) | signed webhooks |
| Vexa bot containers | the internet | 443/tcp, UDP for WebRTC | joining Meet/Teams/Zoom |

Deny everything else between the hosts, in both directions. Publish nothing from the Vexa host on its public interface except what the meeting platforms need outbound. MinIO's console (9001) stays closed to the Vexa host.

## What lives where

| Secret / setting | MeetSum host | Vexa host |
|---|---|---|
| `DATABASE_URL`, Postgres password | yes | **never** |
| `MEETSUM_SESSION_SECRET`, `WEBHOOK_SIGNING_SECRET`, `GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY(S_PREVIOUS)` | yes | **never** |
| OAuth client secrets (Google, Slack, Entra, Notion, HubSpot) | yes | **never** |
| MinIO root user/password | yes | **never** |
| `VEXA_API_KEY` (MeetSum's token for the gateway) | yes | minted by admin-api, stored only as a hash there |
| `VEXA_WEBHOOK_SECRET` | yes | yes (shared signing secret) |
| `VEXA_MINIO_ACCESS_KEY` / `VEXA_MINIO_SECRET_KEY` (bucket-only) | yes (compose env for `vexa-minio-init`) | yes |
| Vexa `ADMIN_TOKEN`, `INTERNAL_API_SECRET`, `DB_PASSWORD`, its own MinIO/valkey settings | no | yes (`vexa.env`, `chmod 600`) |
| Bot Google account browser profile | no | yes |

## Setup

1. **Provision the host.** A VM with ~2.5 GB RAM plus ~1 GB per concurrent bot (see `vexa.md` → Capacity). Prefer rootless Docker (`dockerd-rootless-setuptool.sh install`); a container escape then lands in an unprivileged user.
2. **Join the private network** (Tailscale: `tailscale up --hostname=vexa-bot`; WireGuard: a peer config to the MeetSum VPS). Confirm `ping` both ways over the private addresses only.
3. **MeetSum side.** On the MeetSum VPS, run `vexa-minio-init` once (`docker compose -f docker-compose.prod.yml -f docker-compose.vexa.yml --profile vexa up vexa-minio-init`), then expose MinIO 9000 on the private interface only (a host firewall rule or a bind to the WireGuard address).
4. **Vexa side.** Copy `deploy/vexa/` to the Vexa host. Fill `/opt/vexa/vexa.env` from `vexa.env.example` (`openssl rand -hex 32` per secret), set the MinIO endpoint to MeetSum's private address and the bucket-only key, then `VEXA_ENV_FILE=/opt/vexa/vexa.env deploy/vexa/bootstrap.sh`. The pinned tag/SHA/digest checks in `vexa.lock` apply unchanged.
5. **TLS.** Put the gateway behind a TLS terminator on the Vexa host, bound to the private interface, with a certificate for the private name (Tailscale HTTPS certs or an internal CA).
6. **Token and webhook.** Mint MeetSum's token as in `vexa.md` step 4. In MeetSum's `.env.local` set `VEXA_API_URL=https://<vexa-private-name>:8000`, `VEXA_API_KEY`, `VEXA_WEBHOOK_SECRET`, `MEETSUM_BOT_ENABLED=true`, then redeploy. Run `npm run vexa:configure` (inside the app container) to register the webhook URL and secret.

## Webhook secret flow

`VEXA_WEBHOOK_SECRET` is generated once (`openssl rand -hex 32`), stored in MeetSum's `.env.local` and pushed to Vexa by `npm run vexa:configure`. Vexa signs `<timestamp>.<raw body>` with HMAC-SHA256; MeetSum checks the signature in constant time, a 300 s timestamp window and a 256 KB body cap. To rotate: generate a new secret, update `.env.local`, redeploy MeetSum, run `vexa:configure` again. Webhooks signed with the old secret are rejected from that moment, and the reconcile job recovers any status missed in between.

## Socket-proxy validation (R3)

`deploy/vexa/compose.socket-proxy.yml` puts `tecnativa/docker-socket-proxy` between the runtime and the Docker socket with `CONTAINERS=1 POST=1 IMAGES=0 NETWORKS=0`. Whether Vexa v0.12.28 can spawn bots with `IMAGES=0` and `NETWORKS=0` has **not been verified** (it needs a live Vexa host). Procedure:

1. On the Vexa host, set `VEXA_SOCKET_PROXY=1` in `vexa.env` and rerun `bootstrap.sh` (it adds the proxy file and the `socket-proxy` profile).
2. From the MeetSum host, run the simulator against the live host: `npm run bot:simulate` (not `--fake-vexa`), or start a real test meeting with "Join now".
3. If the bot container fails to start, read `docker compose -p vexa logs runtime` for the refused API call. Enable `IMAGES=1` first (the bot image is pre-pulled, but some runtimes inspect it), rerun, then `NETWORKS=1` if it still fails.
4. Record the result (which flags were needed, the Vexa version, the date) in `deploy/vexa/VERIFIED.md` under "Socket proxy".

Remember that the proxy is not a security boundary: with `CONTAINERS=1` and `POST=1` it still accepts a privileged container create. Isolation comes from the separate host.

## Staleness caveat (R15)

MeetSum ignores out-of-order webhooks using Vexa's event timestamp, a field Vexa does not document as stable. If a Vexa upgrade drops or changes it, the status-rank guard (a webhook can never move a session back to an earlier status) is the backstop, and the reconcile job corrects drift within one interval. After any Vexa upgrade, run `npm run bot:simulate -- --fake-vexa` and one live meeting, and check the status pill walks joining → awaiting admission → recording → done without regressions.
