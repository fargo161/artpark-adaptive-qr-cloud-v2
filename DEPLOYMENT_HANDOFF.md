# ARTPARK Adaptive QR Router v2 — Deployment Handoff

## Goal

Deploy an always-on Node/Express service plus PostgreSQL so the ARTPARK experience runs independently of the concierge computer.

## Required environment variables

- `DATABASE_URL`
- `ADMIN_KEY`
- `MISSION_CONTROL_PASSPHRASE` (shared team login for `/admin`; never expose `ADMIN_KEY` to operators)
- `NODE_ENV=production`
- `PUBLIC_BASE_URL` (used by QR generation/documentation)
- `PGSSL=true` only if the managed PostgreSQL provider requires SSL with this client configuration

## Runtime

- Node 20+
- start command: `npm start`
- health endpoint: `GET /healthz`
- service port: environment `PORT` or 3000

## Database initialization

Schema migrates automatically at application startup.

After production database exists, run once:

```bash
npm run codes:import
```

The import is idempotent; existing codes are skipped.

## Persistent content

Video URL configuration is stored in `app_settings`, not only in the repository. Administrators edit it at `/admin`.

## Team Mission Control

Event staff open `/admin`, enter the shared `MISSION_CONTROL_PASSPHRASE`, and receive a secure HttpOnly server-validated session. They can issue the next unused code, inspect lifecycle state, repair or reset a route with confirmation, use isolated test codes, edit video routing, and log out. They do not need Render, GitHub, PostgreSQL, or `ADMIN_KEY` access.

Production codes move through `UNUSED → ISSUED → ACTIVE → COMPLETE`. Reset deletes the digital visits, removes Active status, and returns the still-valid code to a reusable pre-play state. Test codes use real routing but are excluded from production metrics.

## Concurrency semantics

Station scan is transactional:

1. validate access code;
2. ensure player exists;
3. lock player row `FOR UPDATE`;
4. if the station already exists, return its prior stage;
5. otherwise count prior unique visits and assign next stage;
6. insert visit under unique `(code, station)` and `(code, stage)` constraints;
7. commit;
8. return route/video configuration.

This preserves order under simultaneous group-device scans and makes retries idempotent.

## Final QR generation

Only after the permanent HTTPS hostname is known:

```bash
npm run qr -- --base-url=https://permanent-hostname.example
```

Print the resulting SVG/PNG codes only after manually scanning every one from a real phone on cellular data.

## Recommended pre-event load test

Before festival deployment, run a synthetic load test representing several hundred concurrent station requests against a staging deployment. The code is transaction-safe, but actual capacity depends on the chosen host/database plan and video-hosting arrangement.

## Backup strategy

Use managed PostgreSQL backups if available. At minimum export `access_codes`, `players`, `visits`, and `app_settings` before opening day and after each festival day.
