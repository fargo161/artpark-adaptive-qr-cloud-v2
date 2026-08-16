# ARTPARK Patch Notes — 2026-08-16

Implemented locally from the uploaded production-repo ZIP.

## Changes

- Stations Escape / Attention / Access / Sensory still show exactly four choices, but now each station has one configurable correct choice.
- Mission Control now exposes a **CORRECT CHOICE** selector for every station.
- Wrong station choices do not complete the station and do not write a `video_answers` completion row.
- Wrong station choices return `videoRole: wrong` and use a new station `wrongVideoUrl` slot.
- Player UI plays the wrong-answer/hint video once, then returns to the looping station video/question for unlimited retry.
- Correct station choice persists the station response and uses the existing completion/correct video.
- Mission Control Functional station video routing is now:
  - LOOP VIDEO
  - WRONG ANSWER / HINT VIDEO
  - CORRECT / COMPLETION VIDEO
- Existing stage-based video backups remain migration-safe; existing loop/completion URLs are not overwritten.
- Final question remains **one free-text question**, not two-part and not multiple choice.
- Final question keeps its three video roles:
  - LOOP VIDEO
  - HINT / WRONG ANSWER VIDEO
  - CORRECT ANSWER VIDEO
- Final accepted phrase/reveal behavior is unchanged.

## Production-data safety

No database-table migration was required for the station correct-choice feature. Correct choice and wrong-video URLs are stored in the existing persistent content configuration. Existing `video_answers` rows remain valid completed station responses.

Existing player identity, routes, codes, QR destinations, Mission Control authentication, Start/End behavior, and reset semantics are unchanged.

## Validation performed here

- JavaScript syntax checked for `server.js`, `mission-interface.js`, `public/admin.html`, and `public/station.html`.
- Targeted station/video/identity suite: **50/50 passed**.
- Full `npm test`: **65/66 passed** in this sandbox. The only failure is environmental: the sandbox could not install/load the declared `qrcode` npm dependency used by `test/start-end-qr.test.js`. All tests that do not require that unavailable local package passed.

## First-deploy behavior

For existing production content that has no `correctChoiceIndex`, migration defaults the correct answer to **Choice 1** for each station. Set the intended correct choices in Mission Control after deployment.

Existing station configurations gain a blank `wrongVideoUrl`; paste each station's hint/wrong-answer video URL in Mission Control.
