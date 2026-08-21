# ARTPARK 2026 — Adaptive QR Broadcast Router v2.0

This is the cloud-ready version of the ARTPARK QR puzzle router.

## The simple version

You deploy this app **once** to an always-on cloud host with a PostgreSQL database. After that:

- the four printed QR codes point at the cloud app;
- players use **their own cellular data**;
- one unique access code = one player/group = one persistent progress record;
- the player enters the code once, and the browser remembers them with a secure cookie;
- the cloud database remembers discovery order;
- each Functional station loops its pending video until a response is recorded, then uses its completion video;
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
7. Re-scanning a station preserves its original stage and does not advance the route.
8. On another phone, entering the same code restores the same server-side progress.

At each Functional station, the loop video and four-choice **What could YOU do...?** prompt remain available until a choice is persisted. A visit activates the station but does not complete its mission. Every displayed choice is valid: the interaction records participation and self-positioning, not quiz correctness. The first selected choice is locked, plays that station's completion video, remains visible on revisit, and is stored once per code/station.

Reflective-response state is independent from the Functional discovery route and physical stamps. Selecting a choice does not create a visit or change its stage. One response at each of the four stations sets the authoritative `videoRoundComplete` state.

After all four reflective responses are complete, Start/End exposes one final free-text reflection; visits alone cannot unlock it. The final question has a loop video plus separate wrong- and correct-answer videos. The default question is **What did YOU do to get this far?** Matching is forgiving, deterministic, and server-side: it ignores case, harmless punctuation, apostrophe differences, and repeated whitespace while using token-aware configured keywords and phrases. An unrelated response plays the wrong-answer video, persists nothing, and returns to an unlimited retry.

An accepted final reflection reveals the canonical concierge phrase. Fragments using the vocabulary of decisions, portals, choosing, opening, and crossing are intentionally distributed through the player interface, but the full phrase is returned by the server and displayed only after final acceptance.

## Four permanent station routes

After you have a real domain, print QRs for:

- `/s/escape`
- `/s/attention`
- `/s/access`
- `/s/sensory`

The QR contains only the stable station address. It does **not** contain a video URL. You can change the video routing later without reprinting the QR.

## Start/End framing station

`/s/start-end` is one framing station used for both the opening and closing transmission. It is not a fifth Functional Behavior station and never participates in Stage 1–4. Before the four functional visits are complete it shows START; after all four are complete it shows END. A valid code may be activated at Start/End while retaining an empty `0 / 4` functional route, so the first functional station still becomes Stage 1. Reset returns the same code to the START gate/state.

Start/End activity is intentionally not inserted into `visits` or Recent Signal Activity, keeping functional scan totals and route history unambiguous. Test codes use the same framing logic and remain excluded from production metrics.

## What mission control actually is

The server and database are the real mission control. `/admin` is only a monitor/control window.

You can close your laptop, lose your hotspot, or have no power at concierge and players still function as long as:

1. the cloud deployment is healthy; and
2. their phones have cellular data.

The admin page can be opened from any internet-connected phone or laptop with the shared team Mission Control passphrase. Team operators never need the private server-side `ADMIN_KEY`.

## What the Broadcast Monitor can do

Open `/admin`, enter `MISSION_CONTROL_PASSPHRASE`, and optionally enter an operator label. The secure browser session lasts up to 12 hours and ends immediately when the operator selects **LOG OUT**.

It shows:

- unused, active, and complete production-code counts;
- an atomic **ISSUE NEXT FIELD CODE** control;
- active receiver count;
- a paginated Active Receivers directory showing progress, discovery-order route, completion, and latest activity;
- number of digitally completed routes;
- scan totals per station;
- recent scan activity;
- player lookup by field access code;
- route reset;
- route repair/reconstruction;
- editable loop and completion URLs for each of the four Functional stations;
- editable unauthorized/"come back later" video URL.
- editable player prompts and four choices for every Functional station;
- editable final prompt, accepted phrases, retry copy, completion copy, and loop/wrong/correct video URLs;
- per-player selected responses, reflective completion, final-response state, normalized submission, and timestamps.

### Code lifecycle

- **UNUSED**: a valid production code that has not yet been entered successfully by a player. Displaying, copying, printing, or handing out a code does not change this state.
- **ACTIVE**: successfully entered and representing a current player/group journey.
- **COMPLETE**: active with all four unique digital station visits.

The lifecycle is **UNUSED → ACTIVE → COMPLETE**. **RESET PROGRESS removes Active status and clears the digital route, four reflective choices, final response, and phrase-reveal eligibility. The code remains valid, retains the same persistent player/group identity, and can be activated again at a station, where it starts fresh at Stage 1.** Physical stamps are unaffected.

Mission Control also provides `TEST-01` through `TEST-05`. Test codes use the real authorization, cookie, routing, recovery, and video behavior, but are excluded from production inventory, activity, station-scan, and completion metrics.

The **Active Receivers** directory uses the same lifecycle definition as the Active Receivers counter: production codes with `status=active`. Completed routes remain active and receive a visible `COMPLETE` badge. Reset codes and test credentials do not appear. Results load 50 at a time, most-recent first by default, with code and progress sorting available.

Video URL changes live in PostgreSQL, so changing them does not require new QR codes.

## Database

v2 uses PostgreSQL rather than `players.json`. The schema is in `schema.sql` and is created automatically at startup.

Tables:

- `access_codes` — valid credentials and activation state;
- `players` — one row per activated player/group;
- `visits` — station discovery order;
- `video_answers` — one selected reflective choice per code and station;
- `final_reflections` — one accepted final free-text response per code;
- `app_settings` — persistent video routing configuration.

`players.code` is both the primary key and a foreign key to `access_codes.code`. This database constraint makes the identity rule mathematical rather than cookie-dependent: **one unique access code = one player/group = one persistent record**. Activation locks the access-code row and uses an idempotent unique insert, so two phones activating the same unused code converge on that same record. Re-entering an active or complete code restores visits, selected choices, and final-reflection state. Reset clears state on that identity instead of inserting a second historical player.

A row lock on the player record serializes simultaneous scans. If two members of one group scan different stations at nearly the same time, the database gives them a deterministic Stage N and Stage N+1 rather than corrupting the record.

## Reflective response and final-reflection configuration

Mission Control's **Reflective Station Responses** section provides one prompt and exactly four editable choices for Escape, Attention, Access, and Sensory. All four are accepted. Selections are stored once under unique key `(code, station)` with the selected copy and completion timestamp; revisiting preserves the first response.

The separate **Final Reflection** editor controls its prompt, accepted keyword/phrase family, gentle retry copy, accepted copy, and loop/wrong/correct video URLs. Final matching happens only on the server, and accepted lists are never included in player configuration or station HTML. The canonical concierge phrase is likewise absent from pre-final templates/config and is returned only after an accepted final submission.

The backward-safe schema migration adds `selected_choice`, backfills it from every existing `accepted_answer`, and retains the legacy column so deployed completion rows remain intact. Previously stored station keyword definitions are replaced by editable four-choice defaults while preserving station prompts. Legacy Stage 1–4 video fields are copied into `deprecatedStageVideos`; each station's prior Stage 1 URL seeds its loop role only when no newer role configuration exists. Completion and final video roles default blank for an operator to configure. Existing access codes, player identities, routes, video URLs, and QR destinations are not regenerated or overwritten.

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

Mission Control groups video routing into Start/End, Functional Stations, Unauthorized, and Final Question. Each Functional station has exactly `loopVideoUrl` and `completionVideoUrl`; the final question has exactly `loopVideoUrl`, `wrongVideoUrl`, and `correctVideoUrl`. Discovery Stage 1–4 remains route history and no longer selects Functional video content.

Mission Control preserves those 17 fields and adds `START/END // START VIDEO` and `START/END // END VIDEO`. Existing persisted values are merged with these new empty defaults rather than overwritten.

## Mission Control QR Code Generator

The authenticated `/admin` dashboard generates six QRs: Start/End, Access, Attention, Escape, Sensory, and Quick Start / Auto-Issue. Every displayed URL, QR preview, PNG, and SVG derives from the same `PUBLIC_BASE_URL` value (falling back to the current request host only when it is not configured). Viewing or downloading from the generator does not change player or database state. Always verify the displayed hostname is the intended permanent print destination before mass printing.

The Quick Start QR encodes only `/quick-start`; it never contains a player code. Deliberately opening it loads a zero-typing browser bridge, which shares an idempotency token across same-browser tabs and atomically claims one unallocated production `UNUSED` code. Matching near-simultaneous requests serialize through `quick_start_claims` and reuse that code. The server then activates the existing one-code/one-player identity, sets the normal persistent player cookie, and redirects to `/s/start-end`. A browser that already has a valid active player is redirected without consuming another code. Quick Start creates no Functional visit, so the first Functional scan remains discovery Stage 1. Automated preview/prefetch requests are rejected.

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
- All four choices at every station tested as valid, persistent, idempotent responses.
- Final reflection tested for locking, forgiving matching, retry, idempotency, and reveal safety.
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
