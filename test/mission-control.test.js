import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  TEST_CODES,
  secureEqual,
  newSessionToken,
  hashSessionToken,
  normalizeOperator,
  validRepairRoute,
  activeDirectoryPage
} from '../mission-control.js';
import { normalizeStation } from '../lib.js';

test('Mission Control passphrases compare exactly and session tokens hash safely', () => {
  assert.equal(secureEqual('correct horse', 'correct horse'), true);
  assert.equal(secureEqual('correct horse', 'wrong horse'), false);
  assert.equal(secureEqual('', 'correct horse'), false);
  const token = newSessionToken();
  assert.ok(token.length >= 40);
  assert.equal(hashSessionToken(token), hashSessionToken(token));
  assert.notEqual(hashSessionToken(token), token);
});

test('operator labels are optional, normalized, and bounded', () => {
  assert.equal(normalizeOperator('  TEDDY   OPS  '), 'TEDDY OPS');
  assert.equal(normalizeOperator(''), 'TEAM');
  assert.equal(normalizeOperator('x'.repeat(80)).length, 40);
});

test('route repair accepts only unique valid stations in discovery order', () => {
  assert.deepEqual(validRepairRoute(['sensory','access','escape'], normalizeStation), ['sensory','access','escape']);
  assert.equal(validRepairRoute(['sensory','sensory'], normalizeStation), null);
  assert.equal(validRepairRoute(['sensory','unknown'], normalizeStation), null);
  assert.equal(validRepairRoute(['escape','attention','access','sensory','escape'], normalizeStation), null);
});

test('five test codes remain valid six-character credentials', () => {
  assert.deepEqual(TEST_CODES, ['TEST01','TEST02','TEST03','TEST04','TEST05']);
});

test('active receiver directory pagination and sorting are bounded', () => {
  assert.deepEqual(activeDirectoryPage({}), { sort: 'recent', offset: 0, limit: 50 });
  assert.deepEqual(activeDirectoryPage({ sort: 'code', offset: '50', limit: '25' }), { sort: 'code', offset: 50, limit: 25 });
  assert.deepEqual(activeDirectoryPage({ sort: 'progress', offset: '-4', limit: '999' }), { sort: 'progress', offset: 0, limit: 100 });
  assert.deepEqual(activeDirectoryPage({ sort: 'invalid', limit: '0' }), { sort: 'recent', offset: 0, limit: 50 });
});

test('schema migration preserves inventory and adds lifecycle, sessions, audit, and test isolation', async () => {
  const schema = await fs.readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  assert.match(schema, /status IN \('unused','active'\)/);
  assert.match(schema, /allocated_at TIMESTAMPTZ/);
  assert.match(schema, /UPDATE access_codes SET status='unused' WHERE status='issued'/);
  assert.match(schema, /is_test BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS mission_control_sessions/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS mission_control_audit/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS video_answers/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS final_reflections/);
  assert.match(schema, /selected_choice TEXT/);
  assert.match(schema, /PRIMARY KEY \(code, station\)/);
  assert.match(schema, /ON CONFLICT \(code\) DO UPDATE SET is_test=TRUE/);
  assert.doesNotMatch(schema, /DROP TABLE|TRUNCATE/);
});

test('server implements atomic issue, isolated metrics, locked reset, and cookie sessions', async () => {
  const server = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /FOR UPDATE SKIP LOCKED LIMIT 1/);
  assert.match(server, /status='unused' AND allocated_at IS NULL/);
  assert.match(server, /SET allocated_at=NOW\(\),activated_at=NULL/);
  assert.match(server, /status: 'unused'/);
  assert.doesNotMatch(server, /issued:\s*counts|status: 'issued'/);
  assert.match(server, /WHERE is_test=FALSE/);
  assert.match(server, /DELETE FROM visits WHERE code=\$1/);
  assert.match(server, /DELETE FROM video_answers WHERE code=\$1/);
  assert.match(server, /DELETE FROM final_reflections WHERE code=\$1/);
  assert.doesNotMatch(server, /DELETE FROM players WHERE code=\$1/);
  assert.match(server, /status='unused',allocated_at=NULL,activated_at=NULL/);
  assert.match(server, /if \(!player\?\.active\)/);
  assert.match(server, /!bodyCode && access\.status !== 'active'/);
  assert.match(server, /HttpOnly; SameSite=Strict/);
  assert.match(server, /DELETE FROM mission_control_sessions WHERE token_hash=\$1/);
  assert.match(server, /status='active',activated_at=COALESCE\(activated_at,NOW\(\)\)/);
});

test('active receiver directory is authenticated, read-only, lifecycle-consistent, and ordered', async () => {
  const server = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');
  const start = server.indexOf("app.get('/api/admin/active-receivers'");
  const end = server.indexOf("app.post('/api/admin/codes/issue'", start);
  assert.ok(start > 0 && end > start);
  const endpoint = server.slice(start, end);
  assert.match(endpoint, /requireAdmin/);
  assert.match(endpoint, /a\.status='active' AND a\.is_test=FALSE/);
  assert.match(endpoint, /ORDER BY v\.stage/);
  assert.match(endpoint, /COUNT\(v\.id\)=4 AS complete/);
  assert.match(endpoint, /MAX\(v\.created_at\)/);
  assert.match(endpoint, /LIMIT \$1 OFFSET \$2/);
  assert.doesNotMatch(endpoint, /\b(?:INSERT|UPDATE|DELETE)\b/);
  assert.doesNotMatch(endpoint, /status='unused'/);
});
