import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { normalizeFinalPlayerName, saveFinalPlayerName } from '../player-profiles.js';
import { DRAWING_POOL_ELIGIBLE_SQL } from '../drawing-pool.js';
import { QUICK_START_ROUTE } from '../quick-start.js';

const read = relative => fs.readFile(new URL(relative, import.meta.url), 'utf8');

function finalNameEndpoint(server) {
  const start = server.indexOf("app.post('/api/final-name'");
  const end = server.indexOf("app.post('/api/start-end'", start);
  assert.ok(start > 0 && end > start);
  return server.slice(start, end);
}

function profileClient(profile = null) {
  const state = { profile: profile && { ...profile }, versions: [], calls: [] };
  return { state, async query(sql, values = []) {
    const statement = String(sql);
    state.calls.push({ statement, values });
    if (statement.startsWith('SELECT * FROM player_profiles')) {
      return { rows: state.profile ? [{ ...state.profile }] : [] };
    }
    if (statement.startsWith('INSERT INTO player_profile_versions')) {
      const version = {
        code: values[0], display_name: values[1], contact_info: values[2], notes: values[3],
        operator: values[4], reason: values[5]
      };
      state.versions.push(version);
      return { rows: [version] };
    }
    if (statement.startsWith('INSERT INTO player_profiles')) {
      state.profile = {
        code: values[0], display_name: values[1], contact_info: values[2], notes: values[3]
      };
      return { rows: [{ ...state.profile }] };
    }
    throw new Error(`Unexpected query: ${statement}`);
  }};
}

test('final name requires a string', () => {
  assert.deepEqual(normalizeFinalPlayerName(undefined), { error: 'NAME_REQUIRED' });
  assert.deepEqual(normalizeFinalPlayerName(42), { error: 'NAME_REQUIRED' });
});

test('empty and whitespace-only final names are rejected', () => {
  assert.deepEqual(normalizeFinalPlayerName(''), { error: 'NAME_REQUIRED' });
  assert.deepEqual(normalizeFinalPlayerName('   \n  '), { error: 'NAME_REQUIRED' });
});

test('final names longer than 80 characters are rejected', () => {
  assert.deepEqual(normalizeFinalPlayerName('x'.repeat(81)), { error: 'NAME_TOO_LONG' });
  assert.deepEqual(normalizeFinalPlayerName('x'.repeat(80)), { name: 'x'.repeat(80) });
});

test('Unicode final names are preserved and surrounding whitespace is trimmed', () => {
  assert.deepEqual(normalizeFinalPlayerName('  Zoë 星 🌟  '), { name: 'Zoë 星 🌟' });
});

test('player name update preserves operator contact information and notes', async () => {
  const client = profileClient({ code: 'ABC123', display_name: 'Old', contact_info: 'private@example.com', notes: 'Operator note' });
  const saved = await saveFinalPlayerName(client, 'ABC123', 'Teddy', 'PLAYER');
  assert.equal(saved.profile.display_name, 'Teddy');
  assert.equal(saved.profile.contact_info, 'private@example.com');
  assert.equal(saved.profile.notes, 'Operator note');
});

test('changed player name creates an UPDATE recovery version attributed to PLAYER', async () => {
  const client = profileClient({ code: 'ABC123', display_name: 'Old', contact_info: 'contact', notes: 'notes' });
  await saveFinalPlayerName(client, 'ABC123', 'New', 'PLAYER');
  assert.deepEqual(client.state.versions, [{
    code: 'ABC123', display_name: 'Old', contact_info: 'contact', notes: 'notes',
    operator: 'PLAYER', reason: 'UPDATE'
  }]);
});

test('same-name resubmission succeeds without duplicate history or write', async () => {
  const current = { code: 'ABC123', display_name: 'Teddy', contact_info: 'contact', notes: 'notes' };
  const client = profileClient(current);
  const result = await saveFinalPlayerName(client, 'ABC123', 'Teddy', 'PLAYER');
  assert.equal(result.unchanged, true);
  assert.equal(result.previousNamePresent, true);
  assert.equal(client.state.versions.length, 0);
  assert.equal(client.state.calls.filter(call => call.statement.startsWith('INSERT')).length, 0);
});

test('first player name creates a profile with blank private fields and no empty history', async () => {
  const client = profileClient();
  const result = await saveFinalPlayerName(client, 'ABC123', 'First Name', 'PLAYER');
  assert.equal(result.unchanged, false);
  assert.deepEqual(client.state.profile, {
    code: 'ABC123', display_name: 'First Name', contact_info: '', notes: ''
  });
  assert.equal(client.state.versions.length, 0);
});

test('final-name endpoint is player-facing and requires the HttpOnly player cookie', async () => {
  const endpoint = finalNameEndpoint(await read('../server.js'));
  assert.match(endpoint, /normalizeAccessCode\(parseCookies\(req\)\[COOKIE_NAME\]\)/);
  assert.match(endpoint, /status\(401\)\.json\(\{ error: 'ACCESS_REQUIRED' \}\)/);
  assert.doesNotMatch(endpoint, /requireAdmin|MISSION_COOKIE|authorization/);
});

test('request body cannot supply or override another player code', async () => {
  const endpoint = finalNameEndpoint(await read('../server.js'));
  assert.doesNotMatch(endpoint, /req\.body\?\.accessCode|codeFromRequest\(req\)/);
  assert.match(endpoint, /req\.body\?\.name/);
});

test('final-name requires an existing active access-code identity', async () => {
  const endpoint = finalNameEndpoint(await read('../server.js'));
  assert.match(endpoint, /lockAccessCode\(client, code\)/);
  assert.match(endpoint, /access\.status !== 'active'/);
});

test('final-name requires final completion for the exact cookie code', async () => {
  const endpoint = finalNameEndpoint(await read('../server.js'));
  assert.match(endpoint, /SELECT code FROM final_reflections WHERE code=\$1/);
  assert.match(endpoint, /FINAL_COMPLETION_REQUIRED/);
  assert.match(endpoint, /status: 409/);
});

test('completion authorization occurs before profile mutation in one transaction', async () => {
  const endpoint = finalNameEndpoint(await read('../server.js'));
  assert.match(endpoint, /withTransaction\(async client/);
  assert.ok(endpoint.indexOf('lockAccessCode(client, code)') < endpoint.indexOf('final_reflections'));
  assert.ok(endpoint.indexOf('final_reflections') < endpoint.indexOf('saveFinalPlayerName'));
});

test('endpoint uses history-aware player-name helper with bounded PLAYER source', async () => {
  const endpoint = finalNameEndpoint(await read('../server.js'));
  assert.match(endpoint, /saveFinalPlayerName\(client, code, validated\.name, 'PLAYER'\)/);
});

test('player final-name audit records flags but no private or actual name values', async () => {
  const endpoint = finalNameEndpoint(await read('../server.js'));
  assert.match(endpoint, /PLAYER_FINAL_NAME_SAVED/);
  assert.match(endpoint, /displayNamePresent: true/);
  assert.match(endpoint, /previousNamePresent: saved\.previousNamePresent/);
  assert.match(endpoint, /unchanged: saved\.unchanged/);
  const auditStart = endpoint.indexOf("await audit(client, 'PLAYER_FINAL_NAME_SAVED'");
  const auditEnd = endpoint.indexOf(');', auditStart);
  assert.doesNotMatch(endpoint.slice(auditStart, auditEnd), /validated\.name|contact|notes|display_name/);
});

test('name saving does not mutate or determine final completion', async () => {
  const endpoint = finalNameEndpoint(await read('../server.js'));
  assert.doesNotMatch(endpoint, /(?:INSERT INTO|UPDATE|DELETE FROM) final_reflections/);
  assert.doesNotMatch(endpoint, /FINAL_PHRASE|videoUrl|videoRole/);
});

test('Drawing Pool eligibility remains final-completion and non-test based', () => {
  assert.match(DRAWING_POOL_ELIGIBLE_SQL, /FROM final_reflections fr/);
  assert.match(DRAWING_POOL_ELIGIBLE_SQL, /a\.is_test=FALSE/);
  assert.doesNotMatch(DRAWING_POOL_ELIGIBLE_SQL, /display_name\s*(?:IS NOT NULL|<>|=)/);
});

test('Drawing Pool naturally reads the saved display name without private fields', () => {
  assert.match(DRAWING_POOL_ELIGIBLE_SQL, /LEFT JOIN player_profiles/);
  assert.match(DRAWING_POOL_ELIGIBLE_SQL, /display_name/);
  assert.doesNotMatch(DRAWING_POOL_ELIGIBLE_SQL, /contact_info|notes/);
});

test('Active Receivers naturally reads the saved display name', async () => {
  const server = await read('../server.js');
  const start = server.indexOf("app.get('/api/admin/active-receivers'");
  const end = server.indexOf("app.get('/api/admin/drawing-pool'", start);
  const active = server.slice(start, end);
  assert.match(active, /LEFT JOIN player_profiles pp ON pp\.code=a\.code/);
  assert.match(active, /displayName: row\.display_name/);
});

test('gameplay reset preserves profile name and profile history', async () => {
  const server = await read('../server.js');
  const start = server.indexOf("app.post('/api/admin/player/:accessCode/reset'");
  const end = server.indexOf("app.put('/api/admin/player/:accessCode/visits'", start);
  assert.doesNotMatch(server.slice(start, end), /DELETE FROM (?:player_profiles|player_profile_versions)/);
});

test('after reset the deleted final completion locks every later final-name write', async () => {
  const server = await read('../server.js');
  const resetStart = server.indexOf("app.post('/api/admin/player/:accessCode/reset'");
  const resetEnd = server.indexOf("app.put('/api/admin/player/:accessCode/visits'", resetStart);
  assert.match(server.slice(resetStart, resetEnd), /DELETE FROM final_reflections WHERE code=\$1/);
  assert.match(finalNameEndpoint(server), /if \(!completion\.rows\[0\]\) return \{ error: 'FINAL_COMPLETION_REQUIRED'/);
});

test('feature requires no final-name table or schema migration', async () => {
  const schema = await read('../schema.sql');
  assert.doesNotMatch(schema, /final_names|winner_names/);
});

test('station UI exposes only the narrow name field, never private profile data', async () => {
  const html = await read('../public/station.html');
  assert.match(html, /id="finalName"/);
  assert.doesNotMatch(html, /contactInfo|contact_info|profileNotes|player_profile_versions|profile history/i);
});

test('winner name form is hidden unless Start-End final acceptance is true', async () => {
  const html = await read('../public/station.html');
  assert.match(html, /id="finalNameArea" class="card hidden"/);
  assert.match(html, /station==='start-end'&&accepted/);
  assert.match(html, /showFinalNameCapture\(Boolean\(state\.available&&state\.accepted\)\)/);
});

test('fresh final acceptance reveals name capture immediately', async () => {
  const html = await read('../public/station.html');
  const start = html.indexOf('async function submitFinal()');
  const end = html.indexOf('async function submitFinalName', start);
  assert.match(html.slice(start, end), /showFinalNameCapture\(true\)/);
  assert.match(html.slice(start, end), /finalReveal.*classList\.remove\('hidden'\)/);
});

test('already-complete Start-End revisits render the name form from persisted acceptance', async () => {
  const [server, html] = await Promise.all([read('../server.js'), read('../public/station.html')]);
  const start = server.indexOf("app.post('/api/start-end'");
  const end = server.indexOf('app.get(STATION_ROUTES', start);
  assert.match(server.slice(start, end), /accepted: player\.finalReflection\.accepted/);
  assert.match(html, /renderFinal\(data\.finalReflection\)/);
});

test('successful save confirms name and code while retaining update capability', async () => {
  const html = await read('../public/station.html');
  assert.match(html, /NAME LOGGED \/\/ \$\{data\.displayName\}/);
  assert.match(html, /FIELD CODE \/\/ \$\{data\.accessCode\}/);
  assert.match(html, /button\.textContent='UPDATE NAME'/);
});

test('name-save failures preserve winner UI and allow retry', async () => {
  const html = await read('../public/station.html');
  const start = html.indexOf('async function submitFinalName');
  const end = html.indexOf('async function scan()', start);
  const submit = html.slice(start, end);
  assert.match(submit, /NAME NOT SAVED \/\/ YOUR WIN STATUS IS SAFE\. TRY AGAIN\./);
  assert.match(submit, /NAME REGISTRY LOCKED \/\/ FINAL COMPLETION REQUIRED\./);
  assert.match(submit, /finally\{button\.disabled=false\}/);
  assert.doesNotMatch(submit, /show\('retry'\)|finalReveal.*hidden|FINAL_PHRASE/);
});

test('name form supports touch, Enter submission, browser name completion, and 80-character limit', async () => {
  const html = await read('../public/station.html');
  assert.match(html, /<form id="finalNameForm">/);
  assert.match(html, /autocomplete="name" maxlength="80"/);
  assert.match(html, /type="submit">SAVE NAME/);
  assert.match(html, /finalNameForm'\)\.addEventListener\('submit',submitFinalName\)/);
});

test('Quick Start route and identity model remain unchanged', () => {
  assert.equal(QUICK_START_ROUTE, '/quick-start');
});
