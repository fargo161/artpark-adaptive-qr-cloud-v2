import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  PROFILE_LIMITS,
  normalizeProfileInput,
  normalizeProfileSearch,
  publicProfile,
  publicProfileVersion,
  upsertPlayerProfile,
  lockProfileAccessCode,
  savePlayerProfileWithHistory,
  deletePlayerProfile,
  restorePlayerProfileVersion
} from '../player-profiles.js';
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
    if (String(sql).startsWith('SELECT * FROM player_profiles')) return { rows: [] };
    return { rows: [{ code: values[0], display_name: values[1] || '' }] };
  }};
  const saved = await upsertPlayerProfile(client, 'ABC123', { displayName: 'Teddy', contactInfo: '', notes: '' });
  await deletePlayerProfile(client, 'ABC123', 'OPS');
  assert.equal(saved.display_name, 'Teddy');
  assert.match(calls[0].sql, /ON CONFLICT \(code\) DO UPDATE/);
  assert.match(calls[2].sql, /DELETE FROM player_profiles WHERE code=\$1/);
  assert.deepEqual(calls[2].values, ['ABC123']);
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
  assert.match(api, /savePlayerProfileWithHistory\(client, code, profile, req\.missionOperator\)/);
  assert.match(api, /deletePlayerProfile\(client, code, req\.missionOperator\)/);
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
  const end = server.indexOf("app.get('/api/admin/player-profiles.csv'", start);
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

test('profile history schema is additive, immutable-shaped, and indexed newest first', async () => {
  const schema = await read('../schema.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS player_profile_versions/);
  assert.match(schema, /id BIGSERIAL PRIMARY KEY/);
  assert.match(schema, /code TEXT NOT NULL REFERENCES access_codes\(code\) ON DELETE CASCADE/);
  assert.match(schema, /reason TEXT NOT NULL CHECK \(reason IN \('UPDATE','CLEAR','RESTORE'\)\)/);
  assert.match(schema, /player_profile_versions\(code,created_at DESC,id DESC\)/);
  assert.doesNotMatch(schema, /UPDATE player_profile_versions|DELETE FROM player_profile_versions/);
});

test('history API representation retains authenticated recovery fields', () => {
  const createdAt = new Date().toISOString();
  assert.deepEqual(publicProfileVersion({
    id: '42', display_name: 'Teddy', contact_info: 'private', notes: 'note',
    operator: 'OPS', reason: 'UPDATE', created_at: createdAt
  }), {
    id: 42, displayName: 'Teddy', contactInfo: 'private', notes: 'note',
    operator: 'OPS', reason: 'UPDATE', createdAt
  });
});

function statefulProfileClient({ profile = null, versions = [] } = {}) {
  const state = { profile: profile && { ...profile }, versions: versions.map(row => ({ ...row })), calls: [] };
  return { state, async query(sql, values = []) {
    const statement = String(sql);
    state.calls.push({ sql: statement, values });
    if (statement.startsWith('SELECT code FROM access_codes')) return { rows: [{ code: values[0] }] };
    if (statement.startsWith('SELECT * FROM player_profile_versions')) {
      const row = state.versions.find(item => Number(item.id) === Number(values[0]) && item.code === values[1]);
      return { rows: row ? [{ ...row }] : [] };
    }
    if (statement.startsWith('SELECT * FROM player_profiles')) return { rows: state.profile ? [{ ...state.profile }] : [] };
    if (statement.startsWith('INSERT INTO player_profile_versions')) {
      const row = { id: state.versions.length + 1, code: values[0], display_name: values[1], contact_info: values[2], notes: values[3], operator: values[4], reason: values[5], created_at: new Date().toISOString() };
      state.versions.push(row);
      return { rows: [{ ...row }] };
    }
    if (statement.startsWith('INSERT INTO player_profiles')) {
      state.profile = { code: values[0], display_name: values[1], contact_info: values[2], notes: values[3], created_at: state.profile?.created_at || new Date().toISOString(), updated_at: new Date().toISOString() };
      return { rows: [{ ...state.profile }] };
    }
    if (statement.startsWith('DELETE FROM player_profiles')) { state.profile = null; return { rows: [] }; }
    throw new Error(`Unexpected query: ${statement}`);
  }};
}

test('brand-new profile save creates no empty history row', async () => {
  const client = statefulProfileClient();
  await savePlayerProfileWithHistory(client, 'ABC123', { displayName: 'First', contactInfo: '', notes: '' }, 'OPS');
  assert.equal(client.state.profile.display_name, 'First');
  assert.equal(client.state.versions.length, 0);
});

test('updating an existing profile snapshots exact previous private values first', async () => {
  const client = statefulProfileClient({ profile: { code: 'ABC123', display_name: 'Old', contact_info: 'old@example', notes: 'old note' } });
  await savePlayerProfileWithHistory(client, 'ABC123', { displayName: 'New', contactInfo: 'new@example', notes: 'new note' }, 'TEDDY OPS');
  assert.deepEqual(client.state.versions.map(({ display_name, contact_info, notes, operator, reason }) => ({ display_name, contact_info, notes, operator, reason })), [
    { display_name: 'Old', contact_info: 'old@example', notes: 'old note', operator: 'TEDDY OPS', reason: 'UPDATE' }
  ]);
  assert.equal(client.state.profile.display_name, 'New');
  assert.ok(client.state.calls.findIndex(call => call.sql.startsWith('INSERT INTO player_profile_versions')) < client.state.calls.findIndex(call => call.sql.startsWith('INSERT INTO player_profiles')));
});

test('clearing a live profile snapshots it before deletion', async () => {
  const client = statefulProfileClient({ profile: { code: 'ABC123', display_name: 'Live', contact_info: 'private', notes: 'keep' } });
  const version = await deletePlayerProfile(client, 'ABC123', 'OPS');
  assert.equal(version.reason, 'CLEAR');
  assert.equal(client.state.versions[0].display_name, 'Live');
  assert.equal(client.state.profile, null);
});

test('clearing an already-empty profile creates no junk history', async () => {
  const client = statefulProfileClient();
  assert.equal(await deletePlayerProfile(client, 'ABC123', 'OPS'), null);
  assert.equal(client.state.versions.length, 0);
  assert.equal(client.state.profile, null);
});

test('restore rejects a missing or wrong-code version without mutation', async () => {
  const original = { code: 'ABC123', display_name: 'Current', contact_info: '', notes: '' };
  const client = statefulProfileClient({ profile: original, versions: [{ id: 7, code: 'ZZZ999', display_name: 'Wrong', contact_info: 'x', notes: 'x' }] });
  assert.equal(await restorePlayerProfileVersion(client, 'ABC123', 7, 'OPS'), null);
  assert.equal(client.state.profile.display_name, 'Current');
  assert.equal(client.state.versions.length, 1);
});

test('restore replaces live values only from the selected database version', async () => {
  const client = statefulProfileClient({
    profile: { code: 'ABC123', display_name: 'Current', contact_info: 'now', notes: 'now' },
    versions: [{ id: 7, code: 'ABC123', display_name: 'Stored', contact_info: 'stored-contact', notes: 'stored-note', operator: 'OLD', reason: 'UPDATE' }]
  });
  const result = await restorePlayerProfileVersion(client, 'ABC123', 7, 'RESTORER');
  assert.equal(result.currentProfileExisted, true);
  assert.deepEqual([client.state.profile.display_name, client.state.profile.contact_info, client.state.profile.notes], ['Stored', 'stored-contact', 'stored-note']);
  assert.equal(client.state.versions[1].reason, 'RESTORE');
  assert.equal(client.state.versions[1].display_name, 'Current');
});

test('restore into an empty current profile is valid and creates no empty snapshot', async () => {
  const client = statefulProfileClient({ versions: [{ id: 3, code: 'ABC123', display_name: 'Recovered', contact_info: '', notes: '', operator: 'OPS', reason: 'CLEAR' }] });
  const result = await restorePlayerProfileVersion(client, 'ABC123', 3, 'RESTORER');
  assert.equal(result.currentProfileExisted, false);
  assert.equal(client.state.profile.display_name, 'Recovered');
  assert.equal(client.state.versions.length, 1);
});

test('restoring is reversible because the displaced current profile becomes history', async () => {
  const client = statefulProfileClient({
    profile: { code: 'ABC123', display_name: 'B', contact_info: '', notes: '' },
    versions: [{ id: 1, code: 'ABC123', display_name: 'A', contact_info: '', notes: '', operator: 'OPS', reason: 'UPDATE' }]
  });
  await restorePlayerProfileVersion(client, 'ABC123', 1, 'OPS');
  const reverseId = client.state.versions[1].id;
  await restorePlayerProfileVersion(client, 'ABC123', reverseId, 'OPS');
  assert.equal(client.state.profile.display_name, 'B');
  assert.deepEqual(client.state.versions.slice(1).map(row => row.reason), ['RESTORE', 'RESTORE']);
});

test('history and restore endpoints are authenticated, bounded, ordered, and code-scoped', async () => {
  const [server, profiles] = await Promise.all([read('../server.js'), read('../player-profiles.js')]);
  assert.match(server, /app\.get\('\/api\/admin\/player-profile\/:code\/history', requireAdmin/);
  assert.match(server, /ORDER BY created_at DESC,id DESC\s+LIMIT 100/);
  assert.match(server, /app\.post\('\/api\/admin\/player-profile\/:code\/restore\/:versionId', requireAdmin/);
  assert.match(profiles, /SELECT \* FROM player_profile_versions WHERE id=\$1 AND code=\$2/);
  assert.match(server, /INVALID_PROFILE_VERSION|PROFILE_VERSION_NOT_FOUND/);
});

test('restore audit contains recovery metadata but no contact information or notes', async () => {
  const server = await read('../server.js');
  const start = server.indexOf("app.post('/api/admin/player-profile/:code/restore/:versionId'");
  const end = server.indexOf("app.get('/api/admin/player-profile/:code'", start);
  const restore = server.slice(start, end);
  assert.match(restore, /PLAYER_PROFILE_RESTORED/);
  assert.match(restore, /versionId/);
  assert.match(restore, /currentProfileExisted/);
  assert.match(restore, /displayNamePresent/);
  assert.doesNotMatch(restore, /contactInfo|contact_info|notes/);
});

test('profile backup CSV is authenticated, live-only, test-marked, private, and safely escaped', async () => {
  const server = await read('../server.js');
  const start = server.indexOf("app.get('/api/admin/player-profiles.csv'");
  const end = server.indexOf("app.get('/api/admin/player-profile/:code/history'", start);
  const backup = server.slice(start, end);
  assert.match(backup, /requireAdmin/);
  assert.match(backup, /FROM player_profiles pp/);
  assert.doesNotMatch(backup, /player_profile_versions/);
  assert.match(backup, /access_code,display_name,contact_info,notes,is_test,updated_at/);
  assert.match(backup, /csvCell\(row\.contact_info\)/);
  assert.match(backup, /csvCell\(row\.notes\)/);
  assert.match(backup, /artpark-player-profiles-backup\.csv/);
  assert.equal((await import('../drawing-pool.js')).csvCell('line 1\n"line 2"'), '"line 1\n""line 2"""');
});

test('gameplay reset preserves profile, profile history, and prize history', async () => {
  const server = await read('../server.js');
  const start = server.indexOf("app.post('/api/admin/player/:accessCode/reset'");
  const end = server.indexOf("app.put('/api/admin/player/:accessCode/visits'", start);
  const reset = server.slice(start, end);
  assert.doesNotMatch(reset, /DELETE FROM (?:player_profiles|player_profile_versions|prize_draws)/);
  assert.match(reset, /DELETE FROM visits/);
  assert.match(reset, /DELETE FROM video_answers/);
  assert.match(reset, /DELETE FROM final_reflections/);
});

test('Mission Control exposes history, restore, backup, and explicit recovery warnings', async () => {
  const html = await read('../public/admin.html');
  assert.match(html, /PROFILE HISTORY/);
  assert.match(html, /RESTORE THIS VERSION/);
  assert.match(html, /DOWNLOAD PROFILE BACKUP CSV/);
  assert.match(html, /PROFILE CLEARED \/\/ RECOVERY COPY SAVED/);
  assert.match(html, /PLAYER PROFILE AND PROFILE HISTORY WILL BE PRESERVED/);
  assert.match(html, /addEventListener\('click',\(\)=>restoreProfileVersion\(entry\)\)/);
});

test('private profile history and backup data remain outside every public player surface', async () => {
  const [server, station, quickStart] = await Promise.all([read('../server.js'), read('../public/station.html'), read('../public/quick-start.html')]);
  const publicStart = server.indexOf("app.get('/api/me'");
  const publicEnd = server.indexOf("app.get('/api/admin/summary'", publicStart);
  const surfaces = `${server.slice(publicStart, publicEnd)}\n${station}\n${quickStart}`;
  assert.doesNotMatch(surfaces, /player_profile_versions|contact_info|contactInfo|profileNotes|player-profiles\.csv/);
});

test('profile mutations acquire the access-code lock before snapshot and mutation', async () => {
  const server = await read('../server.js');
  for (const marker of [
    "app.put('/api/admin/player-profile/:code'",
    "app.delete('/api/admin/player-profile/:code'",
    "app.post('/api/admin/player-profile/:code/restore/:versionId'"
  ]) {
    const start = server.indexOf(marker);
    const end = server.indexOf('\n});', start);
    const endpoint = server.slice(start, end);
    assert.match(endpoint, /withTransaction\(async client/);
    assert.ok(endpoint.indexOf('lockProfileAccessCode(client, code)') < Math.max(endpoint.indexOf('savePlayerProfileWithHistory'), endpoint.indexOf('deletePlayerProfile'), endpoint.indexOf('restorePlayerProfileVersion')));
  }
  const client = statefulProfileClient();
  assert.equal(await lockProfileAccessCode(client, 'ABC123'), true);
});

test('near-concurrent updates serialize into recoverable previous states', async () => {
  const client = statefulProfileClient({ profile: { code: 'ABC123', display_name: 'Original', contact_info: '', notes: '' } });
  let tail = Promise.resolve();
  const edit = profile => {
    const operation = tail.then(() => savePlayerProfileWithHistory(client, 'ABC123', profile, 'OPS'));
    tail = operation.catch(() => {});
    return operation;
  };
  await Promise.all([
    edit({ displayName: 'First', contactInfo: '', notes: '' }),
    edit({ displayName: 'Second', contactInfo: '', notes: '' })
  ]);
  assert.equal(client.state.profile.display_name, 'Second');
  assert.deepEqual(client.state.versions.map(row => row.display_name), ['Original', 'First']);
});
