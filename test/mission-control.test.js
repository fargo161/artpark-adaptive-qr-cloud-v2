import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  TEST_CODES,
  secureEqual,
  newSessionToken,
  hashSessionToken,
  normalizeOperator,
  validRepairRoute
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

test('schema migration preserves inventory and adds lifecycle, sessions, audit, and test isolation', async () => {
  const schema = await fs.readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  assert.match(schema, /status IN \('unused','active'\)/);
  assert.match(schema, /allocated_at TIMESTAMPTZ/);
  assert.match(schema, /UPDATE access_codes SET status='unused' WHERE status='issued'/);
  assert.match(schema, /is_test BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS mission_control_sessions/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS mission_control_audit/);
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
  assert.match(server, /DELETE FROM players WHERE code=\$1/);
  assert.match(server, /status='unused',allocated_at=NULL,activated_at=NULL/);
  assert.match(server, /if \(!player\?\.active\)/);
  assert.match(server, /!bodyCode && valid\.rows\[0\]\.status !== 'active'/);
  assert.match(server, /HttpOnly; SameSite=Strict/);
  assert.match(server, /DELETE FROM mission_control_sessions WHERE token_hash=\$1/);
  assert.match(server, /status='active', activated_at=NOW\(\)/);
});
