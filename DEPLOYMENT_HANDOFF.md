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

Production codes move through `UNUSED → ACTIVE → COMPLETE`. Showing, copying, printing, or handing out a code does not change its `UNUSED` lifecycle state. Reset deletes digital visits, reflective choices, and final-reflection/reveal state; removes Active status; and returns the still-valid code to a reusable pre-play state while retaining its one persistent player/group identity. Test codes use the complete real interface but are excluded from production metrics.

## Reflective station choices and final reflection

Each Functional station presents an editable “What could YOU do...?” prompt and exactly four visible choices with its loop video. Every choice is valid. A station visit means activated, not complete; the persisted response is the sole station-mission completion signal and switches that station to its completion video. Mission Control stores prompts and choices in the existing `content_config` setting, while `video_answers` stores the first selected choice under primary key `(code, station)`. Four rows produce `videoRoundComplete=true`; choices remain separate from visits, discovery stages, and physical stamps.

Once the reflective round reaches four of four, Start/End presents the configurable final free-text question; four visits without four responses do not unlock it. The final question has loop, wrong-answer, and correct-answer video roles. Its accepted phrase family uses the existing deterministic server-side normalization. Wrong submissions persist nothing, play the wrong-answer role, and allow unlimited retry. An accepted answer is stored once in `final_reflections`, plays the correct-answer role, and causes the server to return the canonical concierge phrase. Accepted rules and the full phrase are never sent in ordinary pre-final configuration.

Migration is additive and idempotent: `selected_choice` is added to `video_answers` and backfilled from deployed `accepted_answer` rows, preserving earlier completions. Legacy station prompts are retained while the obsolete graded keyword behavior/configuration is replaced by four-choice defaults. Legacy Functional Stage 1–4 video fields are retained under `deprecatedStageVideos`; Stage 1 seeds the loop role only when a newer role configuration is absent. The eight Functional role fields and three final role fields are otherwise blank until configured in Mission Control. Access-code inventory, identities, visits, videos, and QR destinations are preserved.

## State-based video routing

Mission Control exposes exactly two video roles for each Functional station: loop and completion. Discovery stage remains preserved visit history but no longer selects a video. It also exposes exactly three final-question roles: loop, wrong answer, and correct answer. Start/End start/end framing and the unauthorized video slot remain independent and unchanged.

## Start/End and QR generation

`/s/start-end` derives START versus END from the existing four-visit completion record. Authorization there may activate a code but never inserts a functional visit or consumes Stage 1. Mission Control adds two persisted video fields, `startEnd.startVideoUrl` and `startEnd.endVideoUrl`, using migration-safe defaults.

The authenticated QR Code Generator produces Start/End, the four functional station QRs, and Quick Start / Auto-Issue as 1200px PNG and SVG. URLs derive from `PUBLIC_BASE_URL`; verify the displayed hostname before mass printing. No additional environment variable or database state is required.

`GET /quick-start` is a live allocation route. It reuses an existing valid active player cookie or transactionally selects an unallocated production `UNUSED` row with `FOR UPDATE SKIP LOCKED`, activates its existing player identity, sets the normal player cookie, and redirects to `/s/start-end`. It excludes test codes, creates no visit, and returns a controlled 503 when inventory is exhausted. Cache, robot, referrer, and prefetch protections reduce accidental allocation, but operators should still treat opening the URL as consuming a code for a fresh browser.

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
