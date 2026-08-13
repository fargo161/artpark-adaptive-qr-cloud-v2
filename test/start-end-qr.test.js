import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import QRCode from 'qrcode';
import { QR_DESTINATIONS, normalizeBaseUrl, qrDestinations } from '../qr-routing.js';
import { START_END_ROUTE } from '../lib.js';

test('Start/End uses one stable non-functional station route', () => {
  assert.equal(START_END_ROUTE, '/s/start-end');
  assert.deepEqual(QR_DESTINATIONS.map(item => item.route), [
    '/s/start-end','/s/access','/s/attention','/s/escape','/s/sensory'
  ]);
});

test('all five QR URLs derive from one authoritative normalized base URL', () => {
  assert.equal(normalizeBaseUrl('https://signal.example/'), 'https://signal.example');
  const destinations = qrDestinations('https://signal.example/');
  assert.deepEqual(destinations.map(item => item.url), [
    'https://signal.example/s/start-end',
    'https://signal.example/s/access',
    'https://signal.example/s/attention',
    'https://signal.example/s/escape',
    'https://signal.example/s/sensory'
  ]);
  assert.throws(() => qrDestinations('not-a-url'));
});

test('QR library generates high-resolution PNG and SVG from the same destination', async () => {
  const url = qrDestinations('https://signal.example')[0].url;
  const png = await QRCode.toBuffer(url, { type: 'png', width: 1200, margin: 4, errorCorrectionLevel: 'H' });
  const svg = await QRCode.toString(url, { type: 'svg', margin: 4, errorCorrectionLevel: 'H' });
  assert.deepEqual([...png.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  assert.match(svg, /<svg/);
});

test('Start/End endpoint is read-only, gated, and derives state from authoritative completion', async () => {
  const server = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');
  const start = server.indexOf("app.post('/api/start-end'");
  const end = server.indexOf('app.get(STATION_ROUTES', start);
  assert.ok(start > 0 && end > start);
  const endpoint = server.slice(start, end);
  assert.match(endpoint, /if \(!code\).*ACCESS_REQUIRED/);
  assert.match(endpoint, /status !== 'active'/);
  assert.match(endpoint, /player\.complete \? 'end' : 'start'/);
  assert.doesNotMatch(endpoint, /INSERT INTO visits|UPDATE visits|DELETE FROM visits/);
  assert.doesNotMatch(endpoint, /stage\s*=/);
});

test('Start/End client preserves the access gate and does not join functional scan routing', async () => {
  const html = await fs.readFile(new URL('../public/station.html', import.meta.url), 'utf8');
  assert.match(html, /station==='start-end'/);
  assert.match(html, /startEnd\?'\/api\/start-end':`\/api\/scan\/\$\{station\}`/);
  assert.match(html, /fetch\('\/api\/access'/);
  assert.match(html, /d\.framingState==='end'/);
});

test('Mission Control exposes authenticated QR metadata and asset endpoints without database mutation', async () => {
  const server = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');
  const start = server.indexOf("app.get('/api/admin/qr'");
  const end = server.indexOf("app.post('/api/admin/tests/:accessCode/open'", start);
  assert.ok(start > 0 && end > start);
  const endpoints = server.slice(start, end);
  assert.match(endpoints, /requireAdmin/);
  assert.match(endpoints, /process\.env\.PUBLIC_BASE_URL/);
  assert.match(endpoints, /QRCode\.toBuffer/);
  assert.match(endpoints, /QRCode\.toString/);
  assert.doesNotMatch(endpoints, /pool\.query|withTransaction|\b(?:INSERT|UPDATE|DELETE)\b/);
});

test('Mission Control preserves all existing video fields and adds two Start/End slots', async () => {
  const html = await fs.readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(html, /START\/END \/\/ START VIDEO/);
  assert.match(html, /START\/END \/\/ END VIDEO/);
  assert.match(html, /QR Code Generator/i);
  assert.match(html, /DOWNLOAD PNG/);
  assert.match(html, /DOWNLOAD SVG/);
  assert.match(html, /Verify this hostname/);
});
