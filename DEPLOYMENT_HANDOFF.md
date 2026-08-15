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

Production codes move through `UNUSED → ACTIVE → COMPLETE`. Showing, copying, printing, or handing out a code does not change its `UNUSED` lifecycle state. Reset deletes digital visits and video-answer completions, removes Active status, and returns the still-valid code to a reusable pre-play state while retaining its one persistent player/group identity. Test codes use real routing and answers but are excluded from production metrics.

## Round 2 video answers

Each Functional station presents an editable “What could YOU do...?” prompt after its routed video. Mission Control stores the prompt and one accepted phrase per line in the existing `content_config` setting. Evaluation is server-side and uses deterministic case, punctuation, apostrophe, whitespace, token, and conservative singular/plural normalization. Player endpoints receive prompts but never accepted phrase lists.

Accepted state is stored in `video_answers` with primary key `(code, station)`, normalized accepted response, and completion time. Wrong answers have no penalty and create no row. Correct and repeated correct submissions are idempotent. Four station rows produce `videoRoundComplete=true`; this remains separate from visits, physical stamps, and the existing Start/End rule.

## Start/End and QR generation

`/s/start-end` derives START versus END from the existing four-visit completion record. Authorization there may activate a code but never inserts a functional visit or consumes Stage 1. Mission Control adds two persisted video fields, `startEnd.startVideoUrl` and `startEnd.endVideoUrl`, using migration-safe defaults.

The authenticated QR Code Generator produces Start/End plus the four functional station QRs as 1200px PNG and SVG. URLs derive from `PUBLIC_BASE_URL`; verify the displayed hostname before mass printing. No additional environment variable or database state is required.

## Concurrency semantics

`players.code` is the database primary key and references the unique `access_codes.code`. All activation paths lock the access-code row, insert the player with `ON CONFLICT (code) DO NOTHING`, and then lock/reuse that row. Concurrent first-use requests therefore converge on the same identity. Recovery never clears visits or answers, and reset clears state without deleting the identity row.

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

Use managed PostgreSQL backups if available. At minimum export `access_codes`, `players`, `visits`, `video_answers`, and `app_settings` before opening day and after each festival day.
