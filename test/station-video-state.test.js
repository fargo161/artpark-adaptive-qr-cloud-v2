import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { stationMissionState } from '../lib.js';
import { FINAL_PHRASE, migrateVideoConfiguration } from '../mission-interface.js';

const stations = ['escape','attention','access','sensory'];
const read = path => fs.readFile(new URL(path, import.meta.url), 'utf8');

test('station visit without response is activated but not mission-complete', () => {
  assert.deepEqual(stationMissionState([{ station: 'escape' }], { escape: null }, 'escape'), {
    visited: true,
    responseComplete: false,
    selectedChoice: '',
    state: 'response_required'
  });
});

test('unvisited station remains distinct from response-required station', () => {
  assert.deepEqual(stationMissionState([], {}, 'escape'), {
    visited: false,
    responseComplete: false,
    selectedChoice: '',
    state: 'not_visited'
  });
});

test('persisted response is the single authoritative station-complete definition', () => {
  const response = { selectedChoice: 'Leave', completedAt: '2026-08-15T12:00:00Z' };
  assert.deepEqual(stationMissionState([{ station: 'escape' }], { escape: response }, 'escape'), {
    visited: true,
    responseComplete: true,
    selectedChoice: 'Leave',
    state: 'complete'
  });
});

test('each Functional station has loop, wrong, and completion video roles', async () => {
  const config = JSON.parse(await read('../config.default.json'));
  for (const station of stations) {
    assert.deepEqual(Object.keys(config.videos[station]).sort(), ['completionVideoUrl','loopVideoUrl','wrongVideoUrl']);
  }
});

test('final question has exactly loop, wrong, and correct video roles', async () => {
  const config = JSON.parse(await read('../config.default.json'));
  assert.deepEqual(Object.keys(config.finalReflection.videos).sort(), ['correctVideoUrl','loopVideoUrl','wrongVideoUrl']);
});

test('legacy Stage 1 becomes loop while every Stage 1-4 URL is retained in backup', () => {
  const legacy = {
    videos: Object.fromEntries(stations.map(station => [station, {
      '1': `https://video.example/${station}-one.mp4`,
      '2': `https://video.example/${station}-two.mp4`,
      '3': `https://video.example/${station}-three.mp4`,
      '4': `https://video.example/${station}-four.mp4`
    }]))
  };
  const migrated = migrateVideoConfiguration(legacy, { videos: {} });
  assert.equal(migrated.needsMigration, true);
  for (const station of stations) {
    assert.equal(migrated.videos[station].loopVideoUrl, legacy.videos[station]['1']);
    assert.equal(migrated.videos[station].wrongVideoUrl, '');
    assert.equal(migrated.videos[station].completionVideoUrl, '');
    assert.deepEqual(migrated.deprecatedStageVideos[station], legacy.videos[station]);
  }
});

test('new loop/wrong/completion URLs are never overwritten by legacy stage URLs', () => {
  const value = {
    videos: {
      escape: {
        loopVideoUrl: 'https://new.example/loop.mp4',
        wrongVideoUrl: 'https://new.example/wrong.mp4',
        completionVideoUrl: 'https://new.example/complete.mp4',
        '1': 'https://old.example/stage-one.mp4'
      }
    },
    deprecatedStageVideos: { escape: { '2': 'https://old.example/stage-two.mp4' } }
  };
  const migrated = migrateVideoConfiguration(value, { videos: {} });
  assert.deepEqual(migrated.videos.escape, {
    loopVideoUrl: 'https://new.example/loop.mp4',
    wrongVideoUrl: 'https://new.example/wrong.mp4',
    completionVideoUrl: 'https://new.example/complete.mp4'
  });
  assert.equal(migrated.deprecatedStageVideos.escape['1'], 'https://old.example/stage-one.mp4');
  assert.equal(migrated.deprecatedStageVideos.escape['2'], 'https://old.example/stage-two.mp4');
});

test('video-role migration is idempotent after role fields exist', () => {
  const value = { videos: Object.fromEntries(stations.map(station => [station, {
    loopVideoUrl: `${station}-loop`, wrongVideoUrl: `${station}-wrong`, completionVideoUrl: `${station}-complete`
  }])) };
  const first = migrateVideoConfiguration(value, { videos: {} });
  const second = migrateVideoConfiguration({ videos: first.videos, deprecatedStageVideos: first.deprecatedStageVideos }, { videos: {} });
  assert.equal(first.needsMigration, false);
  assert.equal(second.needsMigration, false);
  assert.deepEqual(second.videos, first.videos);
});

test('Functional scan selects loop before response and completion after response, never by stage', async () => {
  const server = await read('../server.js');
  const start = server.indexOf("app.post('/api/scan/:station'");
  const end = server.indexOf("app.post('/api/response/:station'", start);
  const endpoint = server.slice(start, end);
  assert.match(endpoint, /missionState\.responseComplete \? 'completion' : 'loop'/);
  assert.match(endpoint, /completionVideoUrl/);
  assert.match(endpoint, /loopVideoUrl/);
  assert.doesNotMatch(endpoint, /videos\?\.\[station\]\?\.\[String\(stage\)\]/);
  assert.match(endpoint, /stageMeta: config\.stages\[String\(stage\)\]/);
});

test('response persistence rejects wrong choices and completes only the configured correct choice', async () => {
  const server = await read('../server.js');
  const start = server.indexOf("app.post('/api/response/:station'");
  const end = server.indexOf("app.post('/api/final-reflection'", start);
  const endpoint = server.slice(start, end);
  assert.match(endpoint, /correctChoiceIndex/);
  assert.match(endpoint, /submittedChoiceIndex !== correctChoiceIndex/);
  assert.match(endpoint, /accepted: false/);
  assert.match(endpoint, /videoRole: 'wrong'/);
  assert.match(endpoint, /wrongVideoUrl/);
  assert.match(endpoint, /videoRole: 'completion'/);
  assert.match(endpoint, /completionVideoUrl/);
  assert.match(endpoint, /stationCompletionMessage\(result\.player\)/);
  const wrongStart = endpoint.indexOf('submittedChoiceIndex !== correctChoiceIndex');
  const insertStart = endpoint.indexOf('INSERT INTO video_answers');
  assert.ok(wrongStart > 0 && insertStart > wrongStart);
  assert.doesNotMatch(endpoint.slice(wrongStart, insertStart), /INSERT INTO video_answers/);
  assert.doesNotMatch(endpoint, /INSERT INTO visits|UPDATE visits|DELETE FROM visits/);
});

test('final question cannot unlock from visits and uses four responses as its gate', async () => {
  const server = await read('../server.js');
  const finalStart = server.indexOf("app.post('/api/final-reflection'");
  const finalEnd = server.indexOf("app.post('/api/start-end'", finalStart);
  const endpoint = server.slice(finalStart, finalEnd);
  assert.match(endpoint, /if \(!player\.videoRoundComplete\)/);
  assert.doesNotMatch(endpoint, /player\.complete/);
  const framing = server.slice(finalEnd, server.indexOf('app.get(STATION_ROUTES', finalEnd));
  assert.match(framing, /const finalAvailable = player\.videoRoundComplete/);
});

test('wrong final answer selects wrong video, persists nothing, and keeps unlimited retry', async () => {
  const server = await read('../server.js');
  const start = server.indexOf("app.post('/api/final-reflection'");
  const end = server.indexOf("app.post('/api/start-end'", start);
  const endpoint = server.slice(start, end);
  const wrongStart = endpoint.indexOf('if (!answerMatches');
  const insertStart = endpoint.indexOf('INSERT INTO final_reflections');
  const wrong = endpoint.slice(wrongStart, insertStart);
  assert.match(wrong, /accepted: false/);
  assert.match(wrong, /videoRole: 'wrong'/);
  assert.match(wrong, /wrongVideoUrl/);
  assert.doesNotMatch(wrong, /INSERT|UPDATE|DELETE/);
});

test('correct final answer persists completion and selects correct video', async () => {
  const server = await read('../server.js');
  const start = server.indexOf("app.post('/api/final-reflection'");
  const end = server.indexOf("app.post('/api/start-end'", start);
  const endpoint = server.slice(start, end);
  assert.match(endpoint, /INSERT INTO final_reflections/);
  assert.match(endpoint, /videoRole: 'correct'/);
  assert.match(endpoint, /correctVideoUrl/);
  assert.match(endpoint, /finalPhrase: FINAL_PHRASE/);
});

test('Start/End returns final loop while pending and correct video only after acceptance', async () => {
  const server = await read('../server.js');
  const start = server.indexOf("app.post('/api/start-end'");
  const end = server.indexOf('app.get(STATION_ROUTES', start);
  const endpoint = server.slice(start, end);
  assert.match(endpoint, /player\.finalReflection\.accepted \? 'correct' : 'loop'/);
  assert.match(endpoint, /correctVideoUrl/);
  assert.match(endpoint, /loopVideoUrl/);
  assert.match(endpoint, /player\.finalReflection\.accepted \? FINAL_PHRASE : null/);
});

test('player UI distinguishes unidentified, pending, and identified signal states without revealing station identity', async () => {
  const html = await read('../public/station.html');
  assert.match(html, /UNIDENTIFIED BROADCAST/);
  assert.match(html, /IDENTIFY THIS BROADCAST FRAGMENT TO CONTINUE/);
  assert.match(html, /SIGNAL CONFIRMED \/\/ IDENTIFICATION ACCEPTED/);
  assert.match(html, /YOUR RESPONSE:/);
  assert.match(html, /REPLAY LOOP/);
  assert.match(html, /REPLAY COMPLETION/);
  assert.match(html, /SIGNAL FRAGMENTS/);
  assert.match(html, /FRAGMENT \$\{index\+1\}/);
  assert.doesNotMatch(html, /\$\{station\.toUpperCase\(\)\} \/\/ YOUR DECISION/);
  assert.doesNotMatch(html, /stationMeta\.subtitle\.toUpperCase\(\)/);
  assert.match(html, /startEnd\?data\.stationMeta\.label:'UNIDENTIFIED BROADCAST'/);
});

test('loop media uses real media looping and mobile-safe autoplay fallback', async () => {
  const html = await read('../public/station.html');
  assert.match(html, /video\.loop=Boolean\(options\.loop\)/);
  assert.match(html, /video\.muted=Boolean\(options\.muted\)/);
  assert.match(html, /params\.set\('loop','1'\)/);
  assert.match(html, /params\.set\('playlist',youtube\.id\)/);
  assert.match(html, /video\.play\(\)\.catch\(\(\)=>controlButton/);
  assert.match(html, /PLAY COMPLETION TRANSMISSION/);
});

test('wrong final video returns to loop without clearing the answer field', async () => {
  const html = await read('../public/station.html');
  assert.match(html, /FINAL \/\/ WRONG ANSWER VIDEO/);
  assert.match(html, /onEnded:renderFinalLoop/);
  assert.match(html, /RETURN TO FINAL QUESTION/);
  assert.doesNotMatch(html, /finalAnswer['"]?\)\.value\s*=\s*['"]{2}/);
});

test('canonical phrase is absent from every pre-final template and config', async () => {
  const [html, defaults] = await Promise.all([read('../public/station.html'), read('../config.default.json')]);
  assert.equal(FINAL_PHRASE, 'DECISIONS ARE PORTALS. PORTALS ARE DECISIONS.');
  assert.doesNotMatch(html, /DECISIONS ARE PORTALS\. PORTALS ARE DECISIONS\./);
  assert.doesNotMatch(defaults, /DECISIONS ARE PORTALS\. PORTALS ARE DECISIONS\./);
});

test('Mission Control exposes eight Functional and three final video roles without stage inputs', async () => {
  const html = await read('../public/admin.html');
  assert.match(html, /dataset\.videoRole='loopVideoUrl'/);
  assert.match(html, /dataset\.videoRole='wrongVideoUrl'/);
  assert.match(html, /dataset\.videoRole='completionVideoUrl'/);
  assert.match(html, /FINAL QUESTION \/\/ LOOP VIDEO/);
  assert.match(html, /FINAL QUESTION \/\/ HINT \/ WRONG ANSWER VIDEO/);
  assert.match(html, /FINAL QUESTION \/\/ CORRECT ANSWER VIDEO/);
  assert.doesNotMatch(html, /data-stage|\/\/ STAGE \$\{stage\}/);
});

test('Field Record Lookup reports visits, response completion, selected choice, and final lock state', async () => {
  const html = await read('../public/admin.html');
  assert.match(html, /VISITED \$\{mission\.visited\?'YES':'NO'\}/);
  assert.match(html, /RESPONSE \$\{mission\.responseComplete\?'COMPLETE':'PENDING'\}/);
  assert.match(html, /SELECTED: \$\{mission\.selectedChoice\}/);
  assert.match(html, /player\.videoRoundComplete\?'PENDING':'LOCKED'/);
});

test('test codes use the same real station and final endpoints while remaining isolated in metrics', async () => {
  const server = await read('../server.js');
  assert.doesNotMatch(server.slice(server.indexOf("app.post('/api/scan/:station'"), server.indexOf("app.get('/api/admin/summary'")), /is_test/);
  const summaryStart = server.indexOf("app.get('/api/admin/summary'");
  const summaryEnd = server.indexOf("app.get('/api/admin/active-receivers'", summaryStart);
  assert.match(server.slice(summaryStart, summaryEnd), /a\.is_test=FALSE/);
});


test('access-code entry is restricted to Start/End while locked Functional stations only direct players to concierge', async () => {
  const [server, html] = await Promise.all([read('../server.js'), read('../public/station.html')]);
  const accessStart = server.indexOf("app.post('/api/access'");
  const accessEnd = server.indexOf("app.post('/api/logout'", accessStart);
  const accessEndpoint = server.slice(accessStart, accessEnd);
  assert.match(accessEndpoint, /entryPoint !== 'start-end'/);
  assert.match(accessEndpoint, /ACCESS_ENTRY_RESTRICTED_TO_START_END/);
  assert.match(html, /station==='start-end'/);
  assert.match(html, /accessEntry/);
  assert.match(html, /classList\.toggle\('hidden',!startEnd\)/);
  assert.match(html, /CONCIERGE START\/END RECEIVER/);
  assert.match(html, /entryPoint:'start-end'/);
});

test('station success copy reports exact remaining identification count and sends the fourth completion back to Start/End', async () => {
  const [server, html] = await Promise.all([read('../server.js'), read('../public/station.html')]);
  assert.match(server, /function stationCompletionMessage\(player\)/);
  assert.match(server, /4 - Number\(player\?\.videoAnswerCount \|\| 0\)/);
  assert.match(server, /ALL FOUR SIGNALS IDENTIFIED \/\/ RETURN TO START\/END/);
  assert.match(server, /FRAGMENT REMAINS/);
  assert.match(server, /FRAGMENTS REMAIN/);
  assert.match(html, /function identificationSuccessMessage\(player\)/);
  assert.match(html, /identificationSuccessMessage\(player\)/);
  assert.match(html, /ALL FOUR SIGNALS IDENTIFIED \/\/ RETURN TO START\/END/);
});
