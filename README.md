# ARTPARK 2026 — Adaptive QR Broadcast Router v2.0

This is the cloud-ready version of the ARTPARK QR puzzle router.

## The simple version

You deploy this app **once** to an always-on cloud host with a PostgreSQL database. After that:

- the four printed QR codes point at the cloud app;
- players use **their own cellular data**;
- one unique access code = one player/group = one persistent progress record;
- the player enters the code once, and the browser remembers them with a secure cookie;
- the cloud database remembers discovery order;
- the correct station × stage video is selected automatically;
- your concierge laptop is **not required for the game to keep running**;
- your phone or laptop is only an optional Broadcast Monitor.

The physical rubber stamps remain the proof that a lockbox was actually solved. A QR scan is narrative progress, not physical completion proof.

## Player flow

1. Concierge gives a card and unique code such as `K7M-4Q2`.
2. Player scans any station QR.
3. On first scan only, they enter the code.
4. The app sets a long-lived browser cookie and activates that code.
5. That station becomes discovery Stage 1.
6. Next new station becomes Stage 2, etc.
7. Re-scanning a station replays its original stage and does not advance the route.
8. On another phone, entering the same code restores the same server-side progress.

## Four permanent station routes

After you have a real domain, print QRs for:

- `/s/escape`
- `/s/attention`
- `/s/access`
- `/s/sensory`

The QR contains only the stable station address. It does **not** contain a video URL. You can change the video routing later without reprinting the QR.

## What mission control actually is

The server and database are the real mission control. `/admin` is only a monitor/control window.

You can close your laptop, lose your hotspot, or have no power at concierge and players still function as long as:

1. the cloud deployment is healthy; and
2. their phones have cellular data.

The admin page can be opened from any internet-connected phone or laptop with the shared team Mission Control passphrase. Team operators never need the private server-side `ADMIN_KEY`.

## What the Broadcast Monitor can do

Open `/admin`, enter `MISSION_CONTROL_PASSPHRASE`, and optionally enter an operator label. The secure browser session lasts up to 12 hours and ends immediately when the operator selects **LOG OUT**.

It shows:

- unused, issued, active, and complete production-code counts;
- an atomic **ISSUE NEXT FIELD CODE** control;
- active receiver count;
- number of digitally completed routes;
- scan totals per station;
- recent scan activity;
- player lookup by field access code;
- route reset;
- route repair/reconstruction;
- editable URLs for all 16 station × stage video slots;
- editable unauthorized/"come back later" video URL.

### Code lifecycle

- **UNUSED**: valid production inventory that has not been issued or activated.
- **ISSUED**: reserved by Mission Control but not yet entered by a player.
- **ACTIVE**: successfully entered and representing a current player/group journey.
- **COMPLETE**: active with all four unique digital station visits.

**RESET PROGRESS removes Active status and clears the digital route. The code remains valid and can be activated again at a station, where it starts fresh at Stage 1.** Physical stamps are unaffected.

Mission Control also provides `TEST-01` through `TEST-05`. Test codes use the real authorization, cookie, routing, recovery, and video behavior, but are excluded from production inventory, activity, station-scan, and completion metrics.

Video URL changes live in PostgreSQL, so changing them does not require new QR codes.

## Database

v2 uses PostgreSQL rather than `players.json`. The schema is in `schema.sql` and is created automatically at startup.

Tables:

- `access_codes` — valid credentials and activation state;
- `players` — one row per activated player/group;
- `visits` — station discovery order;
- `app_settings` — persistent video routing configuration.

A row lock on the player record serializes simultaneous scans. If two members of one group scan different stations at nearly the same time, the database gives them a deterministic Stage N and Stage N+1 rather than corrupting the record.

## Important weak-signal behavior

Station registration is idempotent.

If the phone reaches the server and the visit is recorded but the response/video fails to load, scanning again returns the **same station and same stage**. It does not advance again.

If the phone never reaches the server, no progress is recorded. The mobile page presents a SIGNAL DEGRADED retry screen.

## Videos

The package intentionally does not include final video files.

The admin dashboard accepts:

- normal YouTube URLs (embedded automatically);
- direct `.mp4`, `.webm`, or `.ogg` URLs (native mobile video player);
- other external URLs (open as external transmission).

For field reliability, short 720p H.264 MP4 files on a CDN/object-storage service are a strong eventual choice. The current broadcast/VHS aesthetic does not require 4K delivery.

## First local test — easiest method

Install Docker Desktop, then from this folder:

```bash
docker compose up --build
```

In another terminal, import the included 2,500 codes:

```bash
docker compose exec app npm run codes:import
```

Then open:

- Player station: `http://localhost:3000/s/attention`
- Broadcast Monitor: `http://localhost:3000/admin`
- Local admin key: `local-development-only`

Use any code from `data/access_codes.csv`.

## Non-Docker local setup

Requirements: Node 20+ and PostgreSQL.

Set:

```bash
DATABASE_URL=postgres://...
ADMIN_KEY=some-long-secret
MISSION_CONTROL_PASSPHRASE=shared-team-passphrase
NODE_ENV=development
```

Then:

```bash
npm install
npm run codes:import
npm start
```

## Cloud deployment model

Use any host that supports:

- an always-on Node 20 container/service;
- PostgreSQL;
- environment variables;
- a public HTTPS URL.

Set at minimum:

```text
DATABASE_URL=...
ADMIN_KEY=...
MISSION_CONTROL_PASSPHRASE=...
NODE_ENV=production
PUBLIC_BASE_URL=https://your-real-domain.example
```

The `Dockerfile` is provider-neutral. The host does not need your concierge computer to stay online.

After the first deployment:

1. run `npm run codes:import` once against the production database;
2. open `/admin` and set your video URLs;
3. test all four station routes with several access codes;
4. generate final QR art only after the permanent public domain is locked.

## Generate final printable QR files

Once the real domain exists:

```bash
npm run qr -- --base-url=https://signal.your-real-domain.example
```

This creates high-resolution PNG and SVG QR files in `qr/`, plus a `.txt` file documenting each encoded URL.

**Do not print the included QR directory until it has been regenerated for the actual permanent domain.**

## Production checklist

- Cloud service and PostgreSQL both healthy.
- `/healthz` returns `{ "ok": true }`.
- Strong random `ADMIN_KEY` configured.
- 2,500 codes imported.
- Four station URLs tested from cellular data, not venue Wi-Fi.
- All desired video slots set in `/admin`.
- Unauthorized holding video set if desired.
- Final QRs regenerated against permanent HTTPS domain.
- QR signs tested after printing.
- Several complete random-order routes tested on real phones.
- Recovery tested by entering one active code on a second phone.
- Concierge has printed backup access-code sheets/cards.
- Physical stamps remain the completion authority.

## Security / operational notes

This is a low-stakes festival credential system, not an account platform. Access codes are effectively bearer credentials: anyone who knows a code can restore that group's progress. That is deliberate for simple field recovery.

Keep the admin key and Mission Control passphrase private. Operators use only the passphrase; `ADMIN_KEY` remains a server-side maintenance credential and is never sent to the Mission Control browser.

## Files worth knowing

- `server.js` — routes and cloud behavior
- `db.js` — PostgreSQL connection
- `schema.sql` — persistent data model
- `config.default.json` — initial visual/content configuration
- `public/station.html` — player mobile interface
- `public/admin.html` — Broadcast Monitor
- `data/access_codes.csv` — included 2,500 field codes
- `scripts/import-codes.js` — loads codes into PostgreSQL
- `scripts/generate-qr.js` — generates final station QR files
- `FIELD_OPERATIONS_QUICKSTART.md` — what you personally do at the festival
- `DEPLOYMENT_HANDOFF.md` — what a developer/Codex needs to deploy it
