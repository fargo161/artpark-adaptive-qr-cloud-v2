import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { normalizeAnswer, answerMatches, sanitizeAnswerDefinition } from '../answer-matching.js';
import { publicVideoAnswers, safeConfigForPlayer } from '../lib.js';

const accepted = ['leave', 'get out', 'walk away', 'go', "don't panic", 'call'];

test('configured keyword is accepted', () => assert.equal(answerMatches('leave', accepted), true));
test('configured phrase is accepted', () => assert.equal(answerMatches('I would get out now', accepted), true));
test('answer matching is case-insensitive', () => assert.equal(answerMatches('WALK AWAY', accepted), true));
test('harmless surrounding punctuation is ignored', () => assert.equal(answerMatches('...leave!!!', accepted), true));
test('repeated whitespace is normalized', () => assert.equal(answerMatches('please   get\t out', accepted), true));
test('apostrophe differences are normalized', () => assert.equal(answerMatches('I would dont panic', accepted), true));
test('safe plural variants are accepted', () => assert.equal(answerMatches('She calls for help', accepted), true));
test('unrelated answers are rejected', () => assert.equal(answerMatches('wait quietly', accepted), false));
test('ambiguous substrings do not match', () => {
  assert.equal(answerMatches('ongoing', ['go']), false);
  assert.equal(answerMatches('recall', ['call']), false);
});
test('normalization remains deterministic and explainable', () => {
  assert.equal(normalizeAnswer("  DON’T---Panic!  "), 'dont panic');
  assert.deepEqual(sanitizeAnswerDefinition({
    prompt: '  What   could YOU do? ',
    acceptedPhrases: [' Leave ', 'leave', '', 'Get   out']
  }), { prompt: 'What could YOU do?', acceptedPhrases: ['Leave', 'Get out'] });
});

test('player configuration exposes prompts but not accepted-answer lists', () => {
  const safe = safeConfigForPlayer({
    eventName: 'ARTPARK', locked: {}, startEnd: {}, stations: {}, stages: {},
    answers: Object.fromEntries(['escape','attention','access','sensory'].map(station => [station, {
      prompt: `Prompt for ${station}`,
      acceptedPhrases: ['secret answer']
    }]))
  });
  assert.equal(safe.answers.escape.prompt, 'Prompt for escape');
  assert.doesNotMatch(JSON.stringify(safe), /acceptedPhrases|secret answer/);
});

test('four distinct station answers produce a complete video round', () => {
  const rows = ['escape','attention','access','sensory'].map(station => ({ station, accepted_answer: station, completed_at: new Date() }));
  const states = publicVideoAnswers(rows);
  assert.equal(Object.values(states).filter(Boolean).length, 4);
});

test('answer API is cookie-authorized, server-evaluated, retryable, and idempotent', async () => {
  const server = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');
  const start = server.indexOf("app.post('/api/answer/:station'");
  const end = server.indexOf("app.post('/api/start-end'", start);
  assert.ok(start > 0 && end > start);
  const endpoint = server.slice(start, end);
  assert.match(endpoint, /parseCookies\(req\)\[COOKIE_NAME\]/);
  assert.doesNotMatch(endpoint, /req\.body\?\.accessCode|codeFromRequest/);
  assert.match(endpoint, /answerMatches\(rawAnswer, config\.answers\?\.\[station\]\?\.acceptedPhrases\)/);
  assert.match(endpoint, /SIGNAL NOT YET RESOLVED\. TRY ANOTHER SHORT PHRASE\./);
  assert.match(endpoint, /ON CONFLICT \(code,station\) DO NOTHING/);
  assert.match(endpoint, /SIGNAL INTERPRETATION ACCEPTED/);
  assert.doesNotMatch(endpoint, /INSERT INTO visits|UPDATE visits|DELETE FROM visits|attempt/i);
});

test('one correct answer creates one state and repeated correct answers reuse it', async () => {
  const schema = await fs.readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  const server = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(schema, /PRIMARY KEY \(code, station\)/);
  assert.match(server, /if \(existing\.rows\[0\]\)[\s\S]*accepted: true, duplicate: true/);
  assert.match(server, /ON CONFLICT \(code,station\) DO NOTHING/);
});

test('reset clears route and video answers but preserves the player identity row', async () => {
  const server = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');
  const start = server.indexOf("app.post('/api/admin/player/:accessCode/reset'");
  const end = server.indexOf("app.put('/api/admin/player/:accessCode/visits'", start);
  const endpoint = server.slice(start, end);
  assert.match(endpoint, /DELETE FROM visits WHERE code=\$1/);
  assert.match(endpoint, /DELETE FROM video_answers WHERE code=\$1/);
  assert.match(endpoint, /status='unused',allocated_at=NULL,activated_at=NULL/);
  assert.doesNotMatch(endpoint, /DELETE FROM players/);
});

test('test reset clears real answer state and answer metrics exclude test codes', async () => {
  const server = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');
  const resetStart = server.indexOf("app.post('/api/admin/tests/:accessCode/reset'");
  const resetEnd = server.indexOf("app.get('/api/admin/config'", resetStart);
  assert.match(server.slice(resetStart, resetEnd), /DELETE FROM video_answers WHERE code=\$1/);
  const summaryStart = server.indexOf("app.get('/api/admin/summary'");
  const summaryEnd = server.indexOf("app.get('/api/admin/active-receivers'", summaryStart);
  const summary = server.slice(summaryStart, summaryEnd);
  assert.match(summary, /video_answers/);
  assert.match(summary, /a\.is_test=FALSE/);
});

test('PostgreSQL enforces one code to one persistent player', async () => {
  const schema = await fs.readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS players \([\s\S]*code TEXT PRIMARY KEY REFERENCES access_codes\(code\)/);
  assert.doesNotMatch(schema, /player_id|user_id/);
});

test('simultaneous activation converges through row locking and unique insert recovery', async () => {
  const server = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');
  const lockStart = server.indexOf('async function lockAccessCode');
  const authEnd = server.indexOf("app.get('/healthz'", lockStart);
  const identity = server.slice(lockStart, authEnd);
  assert.match(identity, /access_codes WHERE code=\$1 FOR UPDATE/);
  assert.match(identity, /INSERT INTO players\(code\) VALUES\(\$1\) ON CONFLICT \(code\) DO NOTHING/);
  assert.match(identity, /SELECT code FROM players WHERE code=\$1 FOR UPDATE/);
  assert.match(identity, /COALESCE\(activated_at,NOW\(\)\)/);
});

test('repeat authorization restores state without clearing route or answers', async () => {
  const server = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');
  const start = server.indexOf('async function authorizeCode');
  const end = server.indexOf("app.get('/healthz'", start);
  const authorize = server.slice(start, end);
  assert.match(authorize, /playerRecord\(code, client\)/);
  assert.doesNotMatch(authorize, /DELETE FROM visits|DELETE FROM video_answers|INSERT INTO visits/);
});

test('normal scan and Start/End authorization share the same identity invariant', async () => {
  const server = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');
  const scanStart = server.indexOf("app.post('/api/scan/:station'");
  const scanEnd = server.indexOf("app.post('/api/answer/:station'", scanStart);
  assert.match(server.slice(scanStart, scanEnd), /lockAccessCode\(client, code\)/);
  assert.match(server.slice(scanStart, scanEnd), /ensurePlayerIdentity\(client, code\)/);
  const station = await fs.readFile(new URL('../public/station.html', import.meta.url), 'utf8');
  assert.match(station, /fetch\('\/api\/access'/);
  assert.match(station, /startEnd\?'\/api\/start-end'/);
});

test('Mission Control edits prompts and phrases while player UI submits only an answer', async () => {
  const admin = await fs.readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
  const station = await fs.readFile(new URL('../public/station.html', import.meta.url), 'utf8');
  assert.match(admin, /Video Puzzle Answers/);
  assert.match(admin, /dataset\.answerPrompt/);
  assert.match(admin, /dataset\.answerPhrases/);
  assert.match(admin, /saveAnswerConfig/);
  assert.match(station, /fetch\(`\/api\/answer\/\$\{station\}`/);
  assert.doesNotMatch(station, /acceptedPhrases/);
});
