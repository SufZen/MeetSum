# MeetSum Setup

## Local Development

1. Install dependencies.

```bash
npm install
```

2. Create your local environment file.

```bash
copy .env.example .env.local
```

3. Start the app.

```bash
npm run dev -- --hostname 127.0.0.1 --port 3000
```

4. Verify the baseline.

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

## VPS Development Stack

```bash
docker compose up --build
```

Before production use, replace all placeholder secrets in `.env.local`, configure HTTPS, configure object-storage buckets, and set up database backups.

## Google Workspace

Read `docs/google-workspace-setup.md` before adding real Google credentials. The intended production model is domain-wide delegation with narrow Calendar, Gmail, Drive, and Admin SDK scopes.

## Next Implementation Milestones

Read `docs/development-roadmap.md` for the production-grade development plan.
