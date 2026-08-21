import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import QRCode from 'qrcode';
import {
  QUICK_START_CANDIDATE_SQL,
  QUICK_START_ROUTE,
  QUICK_START_UNAVAILABLE,
  claimQuickStartCandidate,
  isPrefetchRequest
} from '../quick-start.js';
import { QR_DESTINATIONS, qrDestinations } from '../qr-routing.js';

const read = relative => fs.readFile(new URL(relative, import.meta.url), 'utf8');

function quickStartSlice(server) {
  const start = server.indexOf('app.get(QUICK_START_ROUTE');
  const end = server.indexOf("app.get('/healthz'", start);
  assert.ok(start > 0 && end > start);
  return server.slice(start, end);
}

function fakeClient(shared) {
  return {
    async query(sql, values = []) {
      if (String(sql).includes('FOR UPDATE SKIP LOCKED')) {
        const candidate = shared.find(row => row.status === 'unused' && !row.allocated && !row.test && !row.locked);
        if (!candidate) return { rows: [] };
        candidate.locked = true;
        await new Promise(resolve => setTimeout(resolve, 5));
        return { rows: [{ code: candidate.code }] };
      }
      if (String(sql).startsWith('UPDATE access_codes SET allocated_at')) {
        const row = shared.find(candidate => candidate.code === values[0]);
        row.allocated = true;
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

test('Quick Start candidate SQL atomically locks one unallocated UNUSED non-test code', () => {
  assert.equal(QUICK_START_ROUTE, '/quick-start');
  assert.match(QUICK_START_CANDIDATE_SQL, /status='unused'/);
  assert.match(QUICK_START_CANDIDATE_SQL, /allocated_at IS NULL/);
  assert.match(QUICK_START_CANDIDATE_SQL, /is_test=FALSE/);
  assert.match(QUICK_START_CANDIDATE_SQL, /FOR UPDATE SKIP LOCKED/);
  assert.match(QUICK_START_CANDIDATE_SQL, /LIMIT 1/);
});

test('concurrent candidate claims cannot return the same code', async () => {
  const rows = [
    { code: 'AAA111', status: 'unused', allocated: false, test: false, locked: false },
    { code: 'BBB222', status: 'unused', allocated: false, test: false, locked: false }
  ];
  const [first, second] = await Promise.all([
    claimQuickStartCandidate(fakeClient(rows)),
    claimQuickStartCandidate(fakeClient(rows))
  ]);
  assert.deepEqual(new Set([first, second]), new Set(['AAA111', 'BBB222']));
});

test('candidate claim returns null without touching state when inventory is exhausted', async () => {
  const rows = [
    { code: 'TEST01', status: 'unused', allocated: false, test: true, locked: false },
    { code: 'AAA111', status: 'active', allocated: true, test: false, locked: false }
  ];
  assert.equal(await claimQuickStartCandidate(fakeClient(rows)), null);
});

test('prefetch and preview requests are rejected before allocation', () => {
  assert.equal(isPrefetchRequest({ purpose: 'prefetch' }), true);
  assert.equal(isPrefetchRequest({ 'sec-purpose': 'prefetch;prerender' }), true);
  assert.equal(isPrefetchRequest({ purpose: 'preview' }), true);
  assert.equal(isPrefetchRequest({}), false);
});

test('fresh Quick Start uses one transaction, existing identity activation, cookie, audit, and redirect', async () => {
  const server = await read('../server.js');
  const route = quickStartSlice(server);
  assert.match(route, /withTransaction\(async client/);
  assert.match(route, /claimQuickStartCandidate\(client\)/);
  assert.match(route, /ensurePlayerIdentity\(client, claimedCode\)/);
  assert.match(route, /QUICK_START_ACTIVATED/);
  assert.match(route, /setPlayerCookie\(res, code\)/);
  assert.match(route, /redirect\(302, START_END_ROUTE\)/);
});

test('active cookie bypasses allocation while stale cookie is cleared and replaced safely', async () => {
  const server = await read('../server.js');
  const route = quickStartSlice(server);
  const reuse = route.indexOf('existingPlayer?.active');
  const allocation = route.indexOf('claimQuickStartCandidate(client)');
  assert.ok(reuse > 0 && allocation > reuse);
  assert.match(route, /existingPlayer\?\.active.*redirect\(302, START_END_ROUTE\)/s);
  assert.match(route, /clearPlayerCookie\(res\)/);
});

test('unavailable inventory returns controlled 503 without database detail', async () => {
  const server = await read('../server.js');
  const route = quickStartSlice(server);
  assert.match(route, /status\(503\).*QUICK_START_UNAVAILABLE/s);
  assert.equal(QUICK_START_UNAVAILABLE, 'QUICK START TEMPORARILY UNAVAILABLE // REPORT TO CONCIERGE');
});

test('Quick Start discourages caching, robots, referrers, and prefetch', async () => {
  const server = await read('../server.js');
  const headersStart = server.indexOf('function setQuickStartHeaders');
  const routeEnd = server.indexOf("app.get('/healthz'", headersStart);
  const implementation = server.slice(headersStart, routeEnd);
  assert.match(implementation, /no-store/);
  assert.match(implementation, /X-Robots-Tag/);
  assert.match(implementation, /no-referrer/);
  assert.match(implementation, /isPrefetchRequest/);
});

test('Quick Start creates no functional visit and does not duplicate Start/End video logic', async () => {
  const server = await read('../server.js');
  const route = quickStartSlice(server);
  assert.doesNotMatch(route, /INSERT INTO visits|UPDATE visits|DELETE FROM visits/);
  assert.doesNotMatch(route, /startVideoUrl|framingState|videoUrl/);
});

test('QR destination list adds Quick Start after preserving all five existing values', () => {
  assert.deepEqual(QR_DESTINATIONS.map(item => item.route), [
    '/s/start-end', '/s/access', '/s/attention', '/s/escape', '/s/sensory', '/quick-start'
  ]);
  const quickStart = QR_DESTINATIONS.at(-1);
  assert.equal(quickStart.slug, 'quick-start');
  assert.equal(quickStart.name, 'QUICK START / AUTO-ISSUE');
  assert.match(quickStart.warning, /EACH NEW BROWSER SCAN CLAIMS ONE UNUSED PLAYER CODE/);
  assert.equal(qrDestinations('https://signal.example').at(-1).url, 'https://signal.example/quick-start');
});

test('Mission Control retains standard QR controls and shows the live-allocation warning', async () => {
  const html = await read('../public/admin.html');
  assert.match(html, /destination\.warning/);
  assert.match(html, /COPY URL/);
  assert.match(html, /DOWNLOAD PNG/);
  assert.match(html, /DOWNLOAD SVG/);
});

test('Quick Start destination renders through the existing PNG and SVG QR workflow', async () => {
  const url = qrDestinations('https://signal.example').at(-1).url;
  const png = await QRCode.toBuffer(url, {
    type: 'png', width: 1200, margin: 4, errorCorrectionLevel: 'H'
  });
  const svg = await QRCode.toString(url, {
    type: 'svg', margin: 4, errorCorrectionLevel: 'H'
  });
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.match(svg, /<svg/);
});

test('manual authorization and Start/End player flow remain separate and intact', async () => {
  const server = await read('../server.js');
  const manualStart = server.indexOf("app.post('/api/access'");
  const manualEnd = server.indexOf("app.post('/api/logout'", manualStart);
  const startEndStart = server.indexOf("app.post('/api/start-end'");
  const startEndEnd = server.indexOf('app.get(STATION_ROUTES', startEndStart);
  assert.match(server.slice(manualStart, manualEnd), /authorizeCode\(req\.body\?\.accessCode, res\)/);
  assert.match(server.slice(startEndStart, startEndEnd), /config\.startEnd\.startVideoUrl/);
});
