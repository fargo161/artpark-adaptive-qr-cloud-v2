import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { STATION_ROUTES, normalizeAccessCode, formatAccessCode, normalizeStation, nextStageFromVisits, publicVisits } from '../lib.js';

test('admin controls use explicit DOM references and event listeners', async () => {
  const html = await fs.readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
  for (const id of ['adminKey','connect','refresh','logout','lookupCode','lookup','saveRoute','resetPlayer','saveConfig']) {
    assert.match(html, new RegExp(`document\\.getElementById\\('${id}'\\)`));
  }
  assert.doesNotMatch(html, /\.(?:onclick|onkeydown)\s*=/);
  assert.match(html, /connectButton\.addEventListener\('click',connectAdmin\)/);
  assert.match(html, /refreshButton\.addEventListener\('click',refreshDashboard\)/);
});

test('all four public station routes are registered explicitly', () => {
  assert.deepEqual(STATION_ROUTES, [
    '/s/escape',
    '/s/attention',
    '/s/access',
    '/s/sensory'
  ]);
});

test('access codes normalize and format', () => {
  assert.equal(normalizeAccessCode('abc-234'), 'ABC234');
  assert.equal(formatAccessCode('abc234'), 'ABC-234');
  assert.equal(normalizeAccessCode('bad'), '');
});

test('only four known stations are accepted', () => {
  assert.equal(normalizeStation('Escape'), 'escape');
  assert.equal(normalizeStation('unknown'), null);
});

test('next stage derives from unique station history', () => {
  assert.equal(nextStageFromVisits([]), 1);
  assert.equal(nextStageFromVisits([{station:'escape'}]), 2);
  assert.equal(nextStageFromVisits([{station:'escape'},{station:'escape'}]), 2);
  assert.equal(nextStageFromVisits([{station:'escape'},{station:'attention'},{station:'access'}]), 4);
});

test('public visits sort by stage', () => {
  const visits = publicVisits([{station:'access',stage:2},{station:'attention',stage:1}]);
  assert.deepEqual(visits.map(v=>v.station), ['attention','access']);
});
