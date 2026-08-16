import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { normalizeAnswer, answerMatches } from '../answer-matching.js';
import { publicVideoAnswers, safeConfigForPlayer } from '../lib.js';
import { FINAL_PHRASE, sanitizeStationChoiceDefinition, sanitizeFinalReflection, choiceAtIndex } from '../mission-interface.js';

const stations = ['escape','attention','access','sensory'];
const definition = { prompt: 'What could YOU do?', choices: ['Leave','Ask for space','Wait','Change the situation'] };
const finalAccepted = ['choose','chose','decide','decision','participate','I chose'];
const read = path => fs.readFile(new URL(path, import.meta.url), 'utf8');

test('station definitions retain exactly four visible choices', () => {
  assert.deepEqual(sanitizeStationChoiceDefinition(definition), definition);
  const fallback = { prompt: 'Fallback?', choices: ['One','Two','Three','Four'] };
  assert.deepEqual(sanitizeStationChoiceDefinition({ prompt: 'New?', choices: ['Only one'] }, fallback), {
    prompt: 'New?', choices: fallback.choices
  });
});

test('each of the four configured choices is a valid response', () => {
  for (let index = 0; index < 4; index += 1) assert.equal(choiceAtIndex(definition, index), definition.choices[index]);
});

test('invalid, missing, and out-of-range choices are rejected', () => {
  for (const value of [-1, 4, 1.5, '0', 'not-an-index', null, undefined]) assert.equal(choiceAtIndex(definition, value), null);
});

test('final matching accepts configured keywords and phrases', () => {
  assert.equal(answerMatches('I chose another path', finalAccepted), true);
  assert.equal(answerMatches('WE DECIDED TO PARTICIPATE!', finalAccepted), true);
});

test('final matching ignores case, punctuation, whitespace, and apostrophe differences', () => {
  assert.equal(answerMatches('  I   CHOSE... ', finalAccepted), true);
  assert.equal(answerMatches("we don’t decide", ["don't decide"]), true);
});

test('final matching rejects unrelated text and ambiguous substrings', () => {
  assert.equal(answerMatches('we found a secret', finalAccepted), false);
  assert.equal(answerMatches('redecisioning', ['decision']), false);
});

test('final configuration sanitizes prompt, rules, and player-facing copy', () => {
  const result = sanitizeFinalReflection({
    prompt: '  What did YOU do? ', acceptedPhrases: [' Chose ', 'chose'],
    retryMessage: '  Think   about your action. ', acceptedMessage: ' Accepted. '
  });
  assert.deepEqual(result, {
    prompt: 'What did YOU do?', acceptedPhrases: ['Chose'],
    retryMessage: 'Think about your action.', acceptedMessage: 'Accepted.'
  });
});

test('normalization remains deterministic and explainable', () => {
  assert.equal(normalizeAnswer('  I—DECIDED!!!  '), 'i decided');
});

test('player config exposes all choices and final copy but no final accepted-answer list', () => {
  const safe = safeConfigForPlayer({
    eventName: 'ARTPARK', locked: {}, startEnd: {}, stations: {}, stages: {},
    answers: Object.fromEntries(stations.map(station => [station, definition])),
    finalReflection: { prompt: 'What did YOU do?', acceptedPhrases: ['secret answer'], retryMessage: 'Try again.', acceptedMessage: 'Accepted.' }
  });
  assert.equal(safe.answers.escape.choices.length, 4);
  assert.equal(safe.finalReflection.prompt, 'What did YOU do?');
  assert.doesNotMatch(JSON.stringify(safe), /acceptedPhrases|secret answer/);
  assert.doesNotMatch(JSON.stringify(safe), new RegExp(FINAL_PHRASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('four distinct station responses produce a complete reflective round', () => {
  const rows = stations.map(station => ({ station, selected_choice: `${station} choice`, completed_at: new Date() }));
  const states = publicVideoAnswers(rows);
  assert.equal(Object.values(states).filter(Boolean).length, 4);
  assert.equal(states.escape.selectedChoice, 'escape choice');
});

test('production response metrics exclude test-code selections', async () => {
  const server = await read('../server.js');
  const summaryStart = server.indexOf("app.get('/api/admin/summary'");
  const summaryEnd = server.indexOf("app.get('/api/admin/active-receivers'", summaryStart);
  const summary = server.slice(summaryStart, summaryEnd);
  assert.match(summary, /video_answers/);
  assert.match(summary, /JOIN access_codes a ON a\.code=va\.code WHERE a\.is_test=FALSE/);
});

test('legacy accepted answers are exposed as selected choices after migration', () => {
  const states = publicVideoAnswers([{ station: 'escape', accepted_answer: 'legacy response' }]);
  assert.equal(states.escape.selectedChoice, 'legacy response');
});

test('response API is cookie-authorized, choice-based, idempotent, and route-independent', async () => {
  const server = await read('../server.js');
  const start = server.indexOf("app.post('/api/response/:station'");
  const end = server.indexOf("app.post('/api/final-reflection'", start);
  assert.ok(start > 0 && end > start);
  const endpoint = server.slice(start, end);
  assert.match(endpoint, /parseCookies\(req\)\[COOKIE_NAME\]/);
  assert.doesNotMatch(endpoint, /req\.body\?\.accessCode|codeFromRequest|answerMatches/);
  assert.match(endpoint, /choiceAtIndex\(config\.answers\?\.\[station\], req\.body\?\.choiceIndex\)/);
  assert.match(endpoint, /ON CONFLICT \(code,station\) DO NOTHING/);
  assert.match(endpoint, /DECISION LOGGED/);
  assert.doesNotMatch(endpoint, /INSERT INTO visits|UPDATE visits|DELETE FROM visits|correct|incorrect|try again/i);
});

test('one station response creates one locked state and duplicate requests reuse it', async () => {
  const schema = await read('../schema.sql');
  const server = await read('../server.js');
  assert.match(schema, /PRIMARY KEY \(code, station\)/);
  assert.match(server, /if \(existing\.rows\[0\]\)[\s\S]*accepted: true, duplicate: true/);
  assert.match(server, /ON CONFLICT \(code,station\) DO NOTHING/);
});

test('schema migrates legacy answer rows without discarding production data', async () => {
  const schema = await read('../schema.sql');
  assert.match(schema, /ADD COLUMN IF NOT EXISTS selected_choice TEXT/);
  assert.match(schema, /UPDATE video_answers SET selected_choice=accepted_answer WHERE selected_choice IS NULL/);
  assert.match(schema, /ALTER COLUMN selected_choice SET NOT NULL/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS final_reflections/);
  assert.doesNotMatch(schema, /DROP TABLE video_answers|TRUNCATE/);
});

test('final reflection is locked until both progress systems reach four of four', async () => {
  const server = await read('../server.js');
  const start = server.indexOf("app.post('/api/final-reflection'");
  const end = server.indexOf("app.post('/api/start-end'", start);
  const endpoint = server.slice(start, end);
  assert.match(endpoint, /!player\.complete \|\| !player\.videoRoundComplete/);
  assert.match(endpoint, /FINAL_REFLECTION_LOCKED/);
  assert.doesNotMatch(endpoint, /INSERT INTO visits|UPDATE visits|DELETE FROM visits/);
});

test('wrong final reflections return gentle retry copy and persist nothing', async () => {
  const server = await read('../server.js');
  const start = server.indexOf("app.post('/api/final-reflection'");
  const end = server.indexOf("app.post('/api/start-end'", start);
  const endpoint = server.slice(start, end);
  const mismatch = endpoint.indexOf('if (!answerMatches');
  const insert = endpoint.indexOf('INSERT INTO final_reflections');
  assert.ok(mismatch > 0 && insert > mismatch);
  assert.match(endpoint.slice(mismatch, insert), /accepted: false, message: config\.finalReflection\.retryMessage/);
});

test('accepted final reflections persist once and return the canonical phrase', async () => {
  const server = await read('../server.js');
  const start = server.indexOf("app.post('/api/final-reflection'");
  const end = server.indexOf("app.post('/api/start-end'", start);
  const endpoint = server.slice(start, end);
  assert.match(endpoint, /ON CONFLICT \(code\) DO NOTHING/);
  assert.match(endpoint, /finalPhrase: FINAL_PHRASE/);
  assert.match(endpoint, /player\.finalReflection\.accepted[\s\S]*duplicate: true/);
  assert.equal(FINAL_PHRASE, 'DECISIONS ARE PORTALS. PORTALS ARE DECISIONS.');
});

test('Start/End reveals the final phrase only after accepted final reflection', async () => {
  const server = await read('../server.js');
  const start = server.indexOf("app.post('/api/start-end'");
  const end = server.indexOf('app.get(STATION_ROUTES', start);
  const endpoint = server.slice(start, end);
  assert.match(endpoint, /available: finalAvailable/);
  assert.match(endpoint, /finalPhrase: player\.finalReflection\.accepted \? FINAL_PHRASE : null/);
});

test('canonical phrase is absent from pre-final config and player HTML', async () => {
  const [defaults, stationHtml] = await Promise.all([read('../config.default.json'), read('../public/station.html')]);
  assert.doesNotMatch(defaults, new RegExp(FINAL_PHRASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(stationHtml, new RegExp(FINAL_PHRASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(stationHtml, /PORTAL EVENT/);
  assert.match(stationHtml, /A DECISION WAS MADE/);
  assert.doesNotMatch(stationHtml, /DECISIONS ARE[\s\S]{0,160}PORTALS|PORTALS ARE[\s\S]{0,160}DECISIONS/);
});

test('player station renders four buttons and has no station correct-or-wrong loop', async () => {
  const html = await read('../public/station.html');
  assert.match(html, /for\(const \[choiceIndex,choice\] of choices\.entries\(\)\)/);
  assert.match(html, /fetch\(`\/api\/response\/\$\{station\}`/);
  assert.match(html, /body:JSON\.stringify\(\{choiceIndex\}\)/);
  assert.doesNotMatch(html, /api\/answer|acceptedPhrases|INCORRECT|TRY ANOTHER SHORT PHRASE/i);
});

test('player station final input appears only when server marks it available', async () => {
  const html = await read('../public/station.html');
  assert.match(html, /classList\.toggle\('hidden',!state\.available\)/);
  assert.match(html, /fetch\('\/api\/final-reflection'/);
  assert.match(html, /d\.finalPhrase/);
});

test('Mission Control edits four choices and every final-reflection field', async () => {
  const admin = await read('../public/admin.html');
  assert.match(admin, /Reflective Station Responses/);
  assert.match(admin, /dataset\.answerChoice/);
  assert.match(admin, /index<4/);
  assert.match(admin, /finalAcceptedPhrasesInput/);
  assert.match(admin, /saveFinalReflectionConfig/);
  assert.match(admin, /saveFinalReflectionButton\.addEventListener/);
});

test('Mission Control lookup reports selected responses and final state', async () => {
  const admin = await read('../public/admin.html');
  assert.match(admin, /state\.selectedChoice/);
  assert.match(admin, /REFLECTIVE RESPONSES/);
  assert.match(admin, /RESPONSES COMPLETE/);
  assert.match(admin, /FINAL RESPONSE/);
  assert.match(admin, /player\.finalReflection\?\.accepted/);
});

test('all reset paths clear route, responses, and final reveal but preserve identity', async () => {
  const server = await read('../server.js');
  const resetStart = server.indexOf("app.post('/api/admin/player/:accessCode/reset'");
  const resetEnd = server.indexOf("app.put('/api/admin/player/:accessCode/visits'", resetStart);
  const reset = server.slice(resetStart, resetEnd);
  assert.match(reset, /DELETE FROM visits WHERE code=\$1/);
  assert.match(reset, /DELETE FROM video_answers WHERE code=\$1/);
  assert.match(reset, /DELETE FROM final_reflections WHERE code=\$1/);
  assert.match(reset, /status='unused',allocated_at=NULL,activated_at=NULL/);
  assert.doesNotMatch(reset, /DELETE FROM players/);
  const testStart = server.indexOf("app.post('/api/admin/tests/:accessCode/reset'");
  const testEnd = server.indexOf("app.get('/api/admin/config'", testStart);
  assert.match(server.slice(testStart, testEnd), /DELETE FROM final_reflections WHERE code=\$1/);
});

test('PostgreSQL enforces one code to one persistent player', async () => {
  const schema = await read('../schema.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS players \([\s\S]*code TEXT PRIMARY KEY REFERENCES access_codes\(code\)/);
  assert.doesNotMatch(schema, /player_id|user_id/);
});

test('simultaneous activation converges through row locking and unique insert recovery', async () => {
  const server = await read('../server.js');
  const lockStart = server.indexOf('async function lockAccessCode');
  const authEnd = server.indexOf("app.get('/healthz'", lockStart);
  const identity = server.slice(lockStart, authEnd);
  assert.match(identity, /access_codes WHERE code=\$1 FOR UPDATE/);
  assert.match(identity, /INSERT INTO players\(code\) VALUES\(\$1\) ON CONFLICT \(code\) DO NOTHING/);
  assert.match(identity, /SELECT code FROM players WHERE code=\$1 FOR UPDATE/);
});

test('repeat authorization restores all state without clearing anything', async () => {
  const server = await read('../server.js');
  const start = server.indexOf('async function authorizeCode');
  const end = server.indexOf("app.get('/healthz'", start);
  const authorize = server.slice(start, end);
  assert.match(authorize, /playerRecord\(code, client\)/);
  assert.doesNotMatch(authorize, /DELETE FROM visits|DELETE FROM video_answers|DELETE FROM final_reflections|INSERT INTO visits/);
});

test('normal scan and Start/End share authorization while keeping framing out of visits', async () => {
  const server = await read('../server.js');
  const scanStart = server.indexOf("app.post('/api/scan/:station'");
  const scanEnd = server.indexOf("app.post('/api/response/:station'", scanStart);
  assert.match(server.slice(scanStart, scanEnd), /lockAccessCode\(client, code\)/);
  assert.match(server.slice(scanStart, scanEnd), /ensurePlayerIdentity\(client, code\)/);
  const startEndStart = server.indexOf("app.post('/api/start-end'");
  const startEndEnd = server.indexOf('app.get(STATION_ROUTES', startEndStart);
  assert.doesNotMatch(server.slice(startEndStart, startEndEnd), /INSERT INTO visits/);
});
