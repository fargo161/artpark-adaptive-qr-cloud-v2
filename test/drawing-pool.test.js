import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  DRAWING_POOL_ELIGIBLE_SQL,
  DRAWING_POOL_HISTORY_SQL,
  DRAWING_POOL_EXPORT_SQL,
  DRAWING_POOL_RANDOM_SQL,
  drawPrizeWinner,
  csvCell
} from '../drawing-pool.js';

const read = relative => fs.readFile(new URL(relative, import.meta.url), 'utf8');

function fakeDrawClient(shared) {
  return {
    async query(sql, values = []) {
      const statement = String(sql);
      if (statement.includes('pg_advisory_xact_lock')) {
        if (shared.locked) await new Promise(resolve => shared.waiters.push(resolve));
        shared.locked = true;
        return { rows: [] };
      }
      if (statement === DRAWING_POOL_RANDOM_SQL) {
        const allowRepeat = values[0];
        const candidate = shared.codes.find(row => row.final && !row.test && (allowRepeat || !shared.draws.some(draw => draw.code === row.code)));
        return { rows: candidate ? [{ code: candidate.code }] : [] };
      }
      if (statement.includes('INSERT INTO prize_draws')) {
        const row = { id: shared.draws.length + 1, code: values[0], operator: values[1], allow_repeat: values[2], drawn_at: new Date().toISOString() };
        shared.draws.push(row);
        shared.locked = false;
        shared.waiters.splice(0).forEach(resolve => resolve());
        return { rows: [row] };
      }
      throw new Error(`Unexpected query: ${statement}`);
    }
  };
}

test('eligibility is exclusively non-test final reflection completion', () => {
  for (const sql of [DRAWING_POOL_ELIGIBLE_SQL, DRAWING_POOL_RANDOM_SQL, DRAWING_POOL_EXPORT_SQL]) {
    assert.match(sql, /FROM final_reflections fr/);
    assert.match(sql, /JOIN access_codes a ON a\.code=fr\.code/);
    assert.match(sql, /a\.is_test=FALSE/);
    assert.doesNotMatch(sql, /visits|video_answers|status='active'/);
  }
});

test('non-test final-complete codes qualify while visits/responses alone and test completions do not', () => {
  const rows = [
    { code: 'FINAL1', final: true, test: false },
    { code: 'VISIT1', final: false, test: false, visits: 4 },
    { code: 'RESP01', final: false, test: false, responses: 4 },
    { code: 'TEST01', final: true, test: true }
  ];
  assert.deepEqual(rows.filter(row => row.final && !row.test).map(row => row.code), ['FINAL1']);
});

test('draw returns and persists one eligible winner with authenticated operator', async () => {
  const shared = { codes: [{ code: 'FINAL1', final: true, test: false }], draws: [], locked: false, waiters: [] };
  const winner = await drawPrizeWinner(fakeDrawClient(shared), false, 'TEDDY OPS');
  assert.equal(winner.code, 'FINAL1');
  assert.equal(winner.operator, 'TEDDY OPS');
  assert.equal(shared.draws.length, 1);
});

test('no-repeat excludes winners, repeat mode can include them, and empty returns null', async () => {
  const shared = { codes: [{ code: 'FINAL1', final: true, test: false }], draws: [{ code: 'FINAL1' }], locked: false, waiters: [] };
  assert.equal(await drawPrizeWinner(fakeDrawClient(shared), false, 'TEAM'), null);
  const repeated = await drawPrizeWinner(fakeDrawClient(shared), true, 'TEAM');
  assert.equal(repeated.code, 'FINAL1');
  assert.equal(repeated.allow_repeat, true);
});

test('concurrent no-repeat draws serialize and cannot record the same winner', async () => {
  const shared = {
    codes: [{ code: 'FINAL1', final: true, test: false }, { code: 'FINAL2', final: true, test: false }],
    draws: [], locked: false, waiters: []
  };
  const [first, second] = await Promise.all([
    drawPrizeWinner(fakeDrawClient(shared), false, 'ONE'),
    drawPrizeWinner(fakeDrawClient(shared), false, 'TWO')
  ]);
  assert.deepEqual(new Set([first.code, second.code]), new Set(['FINAL1', 'FINAL2']));
  assert.equal(new Set(shared.draws.map(row => row.code)).size, 2);
});

test('history is newest first and repeat mode is persisted without a unique code constraint', async () => {
  const schema = await read('../schema.sql');
  assert.match(DRAWING_POOL_HISTORY_SQL, /ORDER BY drawn_at DESC,id DESC/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS prize_draws/);
  assert.match(schema, /allow_repeat BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.doesNotMatch(schema, /UNIQUE\s*\(code\)/);
});

test('Drawing Pool endpoints require admin, audit winners, and return the controlled empty error', async () => {
  const server = await read('../server.js');
  const start = server.indexOf("app.get('/api/admin/drawing-pool'");
  const end = server.indexOf("app.post('/api/admin/codes/issue'", start);
  const endpoints = server.slice(start, end);
  assert.match(endpoints, /app\.get\('\/api\/admin\/drawing-pool', requireAdmin/);
  assert.match(endpoints, /app\.post\('\/api\/admin\/drawing-pool\/draw', requireAdmin/);
  assert.match(endpoints, /app\.get\('\/api\/admin\/drawing-pool\.csv', requireAdmin/);
  assert.match(endpoints, /req\.missionOperator/);
  assert.match(endpoints, /PRIZE_WINNER_DRAWN/);
  assert.match(endpoints, /status\(409\).*DRAWING_POOL_EMPTY/);
});

test('player reset deletes final completion but preserves prize history', async () => {
  const server = await read('../server.js');
  const start = server.indexOf("app.post('/api/admin/player/:accessCode/reset'");
  const end = server.indexOf("app.put('/api/admin/player/:accessCode/visits'", start);
  const reset = server.slice(start, end);
  assert.match(reset, /DELETE FROM final_reflections WHERE code=\$1/);
  assert.doesNotMatch(reset, /DELETE FROM prize_draws/);
});

test('CSV defaults to no-repeat, supports repeat winners, excludes tests and answer text', () => {
  assert.match(DRAWING_POOL_EXPORT_SQL, /a\.is_test=FALSE/);
  assert.match(DRAWING_POOL_EXPORT_SQL, /previous_winner/);
  assert.match(DRAWING_POOL_EXPORT_SQL, /\$1::boolean OR NOT EXISTS/);
  assert.doesNotMatch(DRAWING_POOL_EXPORT_SQL, /submitted_answer/);
  assert.equal(csvCell('ABC-123'), 'ABC-123');
  assert.equal(csvCell('A,"B"'), '"A,""B"""');
});

test('Mission Control renders summaries, controls, winner, eligible codes, and history safely', async () => {
  const html = await read('../public/admin.html');
  assert.match(html, />DRAWING POOL</);
  assert.match(html, /FINAL COMPLETIONS/);
  assert.match(html, /AVAILABLE FOR NEXT DRAW/);
  assert.match(html, /WINNERS DRAWN/);
  assert.match(html, /DRAW RANDOM WINNER/);
  assert.match(html, /ALLOW PREVIOUS WINNERS/);
  assert.match(html, /EXPORT ELIGIBLE CODES/);
  assert.match(html, /REFRESH DRAWING POOL/);
  assert.match(html, /WINNER \/\/ \$\{winner\.accessCode\}/);
  assert.match(html, /appendDrawingRow/);
  assert.match(html, /drawWinnerButton\.addEventListener\('click',drawRandomWinner\)/);
});
