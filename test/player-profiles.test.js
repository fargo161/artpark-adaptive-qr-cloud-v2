import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PROFILE_LIMITS, normalizeProfileInput, normalizeProfileSearch, publicProfile, upsertPlayerProfile, deletePlayerProfile } from '../player-profiles.js';
import { DRAWING_POOL_ELIGIBLE_SQL, DRAWING_POOL_HISTORY_SQL, DRAWING_POOL_EXPORT_SQL, DRAWING_POOL_RANDOM_SQL } from '../drawing-pool.js';

const read = relative => fs.readFile(new URL(relative, import.meta.url), 'utf8');

test('profile input trims optional fields and enforces documented limits', () => {
  assert.deepEqual(normalizeProfileInput({ displayName: ' Teddy ', contactInfo: '', notes: ' hello ' }), {
    displayName: 'Teddy', contactInfo: '', notes: 'hello'
  });
  assert.deepEqual(normalizeProfileInput({}), { displayName: '', contactInfo: '', notes: '' });
  assert.deepEqual(PROFILE_LIMITS, { displayName: 80, contactInfo: 200, notes: 1000 });
  assert.equal(normalizeProfileInput({ displayName: 'x'.repeat(81) }), null);
  assert.equal(normalizeProfileInput({ contactInfo: 42 }), null);
});

test('empty profile state is returned without requiring a profile row', () => {
  assert.deepEqual(publicProfile(undefined), {
    displayName: '', contactInfo: '', notes: '', createdAt: null, updatedAt: null
  });
});

test('profile helper creates or updates one row and clearing deletes only that profile', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql: String(sql), values });
    return { rows: [{ code: values[0], display_name: values[1] || '' }] };
  }};
  const saved = await upsertPlayerProfile(client, 'ABC123', { displayName: 'Teddy', contactInfo: '', notes: '' });
  await deletePlayerProfile(client, 'ABC123');
  assert.equal(saved.display_name, 'Teddy');
  assert.match(calls[0].sql, /ON CONFLICT \(code\) DO UPDATE/);
  assert.match(calls[1].sql, /DELETE FROM player_profiles WHERE code=\$1/);
  assert.deepEqual(calls[1].values, ['ABC123']);
});

test('schema adds one optional access-code keyed profile without destructive migration', async () => {
  const schema = await read('../schema.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS player_profiles/);
  assert.match(schema, /code TEXT PRIMARY KEY REFERENCES access_codes\(code\) ON DELETE CASCADE/);
  assert.match(schema, /player_profiles_display_name_idx ON player_profiles\(LOWER\(display_name\)\)/);
  assert.doesNotMatch(schema, /ALTER TABLE (?:players|access_codes) ADD[^\r\n]*(?:display_name|contact_info|notes)/);
});

test('authenticated profile APIs create, update, read, clear, validate code, and avoid auditing private text', async () => {
  const server = await read('../server.js');
  const start = server.indexOf("app.get('/api/admin/player-profile-search'");
  const end = server.indexOf("app.post('/api/admin/codes/issue'", start);
  const api = server.slice(start, end);
  assert.match(api, /app\.get\('\/api\/admin\/player-profile\/:code', requireAdmin/);
  assert.match(api, /app\.put\('\/api\/admin\/player-profile\/:code', requireAdmin/);
  assert.match(api, /app\.delete\('\/api\/admin\/player-profile\/:code', requireAdmin/);
  assert.match(api, /upsertPlayerProfile\(client, code, profile\)/);
  assert.match(api, /deletePlayerProfile\(client, code\)/);
  assert.match(api, /PLAYER_PROFILE_UPDATED/);
  assert.match(api, /PLAYER_PROFILE_CLEARED/);
  assert.match(api, /PLAYER_NOT_FOUND/);
  assert.doesNotMatch(api, /audit\([^\n]+(?:contactInfo|notes)/);
});

test('profile save and clear never mutate gameplay tables or lifecycle', async () => {
  const server = await read('../server.js');
  const start = server.indexOf("app.get('/api/admin/player-profile-search'");
  const end = server.indexOf("app.post('/api/admin/codes/issue'", start);
  const api = server.slice(start, end);
  assert.doesNotMatch(api, /(?:INSERT INTO|UPDATE|DELETE FROM) (?:players|visits|video_answers|final_reflections|access_codes)/);
});

test('display-name search is bounded, partial, case-insensitive, and does not expose private fields', async () => {
  const server = await read('../server.js');
  const start = server.indexOf("app.get('/api/admin/player-profile-search'");
  const end = server.indexOf("app.get('/api/admin/player-profile/:code'", start);
  const search = server.slice(start, end);
  assert.equal(normalizeProfileSearch('  teDDy  '), 'teDDy');
  assert.match(search, /LOWER\(pp\.display_name\) LIKE LOWER\(\$1\)/);
  assert.match(search, /`%\$\{query\}%`/);
  assert.match(search, /LIMIT 20/);
  assert.doesNotMatch(search, /contact_info|notes/);
});

test('exact code lookup remains authoritative while name input uses profile search', async () => {
  const [server, html] = await Promise.all([read('../server.js'), read('../public/admin.html')]);
  assert.match(server, /app\.get\('\/api\/admin\/player\/:accessCode'/);
  assert.match(html, /if\(cleaned\.length!==6\)return searchProfiles/);
  assert.match(html, /api\/admin\/player\/\$\{encodeURIComponent\(currentCode\)\}/);
});

test('profiles survive ordinary resets because no reset deletes profile rows', async () => {
  const server = await read('../server.js');
  const resetStart = server.indexOf("app.post('/api/admin/player/:accessCode/reset'");
  const resetEnd = server.indexOf("app.put('/api/admin/player/:accessCode/visits'", resetStart);
  assert.doesNotMatch(server.slice(resetStart, resetEnd), /player_profiles/);
});

test('Active Receivers include optional display names without changing status or sorting', async () => {
  const server = await read('../server.js');
  const start = server.indexOf("app.get('/api/admin/active-receivers'");
  const end = server.indexOf("app.get('/api/admin/drawing-pool'", start);
  const endpoint = server.slice(start, end);
  assert.match(endpoint, /LEFT JOIN player_profiles pp ON pp\.code=a\.code/);
  assert.match(endpoint, /COALESCE\(pp\.display_name,''\) AS display_name/);
  assert.match(endpoint, /a\.status='active' AND a\.is_test=FALSE/);
  assert.match(endpoint, /displayName: row\.display_name/);
});

test('Drawing Pool displays names but eligibility and draw identity remain code-based', () => {
  assert.match(DRAWING_POOL_ELIGIBLE_SQL, /LEFT JOIN player_profiles/);
  assert.match(DRAWING_POOL_HISTORY_SQL, /LEFT JOIN player_profiles/);
  assert.match(DRAWING_POOL_ELIGIBLE_SQL, /FROM final_reflections fr/);
  assert.match(DRAWING_POOL_ELIGIBLE_SQL, /a\.is_test=FALSE/);
  assert.doesNotMatch(DRAWING_POOL_RANDOM_SQL, /display_name|player_profiles/);
});

test('Drawing Pool CSV adds display name and excludes contact, notes, and final answer', async () => {
  const server = await read('../server.js');
  assert.match(DRAWING_POOL_EXPORT_SQL, /display_name/);
  assert.doesNotMatch(DRAWING_POOL_EXPORT_SQL, /contact_info|notes|submitted_answer/);
  assert.match(server, /access_code,display_name,final_completed_at,previous_winner/);
});

test('profile data remains operator-only and cache behavior is unchanged', async () => {
  const [server, station] = await Promise.all([read('../server.js'), read('../public/station.html')]);
  const publicStart = server.indexOf("app.get('/api/me'");
  const publicEnd = server.indexOf("app.get('/api/admin/summary'", publicStart);
  assert.doesNotMatch(server.slice(publicStart, publicEnd), /player_profiles|display_name|contact_info|notes/);
  assert.doesNotMatch(station, /contactInfo|profileNotes|displayName/);
  assert.match(server, /express\.static\(path\.join\(__dirname, 'public'\), \{ maxAge: 0, etag: true, lastModified: true \}\)/);
});
