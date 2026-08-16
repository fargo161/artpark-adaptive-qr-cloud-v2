import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { qrDestinations } from '../qr-routing.js';
import {
  DEFAULT_QR_ARTWORK_ASSIGNMENTS,
  QR_ARTWORK_KEYS,
  START_END_ARTWORK_KEY,
  artworkKeyForDestination,
  qrArtworkCatalog,
  renderStyledQrSvg,
  sanitizeQrArtworkAssignments,
  startEndArtwork
} from '../qr-artwork.js';

function renderOptions(destination, artworkKey) {
  return {
    destinationUrl: destination.url,
    destinationLabel: destination.slug === 'start-end'
      ? 'START / END'
      : `STATION ${destination.stationNumber} // ${destination.name}`,
    artworkKey
  };
}

test('artwork catalog has exactly four interchangeable skins and one fixed Start/End skin', () => {
  assert.deepEqual(QR_ARTWORK_KEYS, ['galaxy', 'spiral', 'beam', 'human']);
  assert.deepEqual(qrArtworkCatalog().map(item => item.key), QR_ARTWORK_KEYS);
  assert.equal(startEndArtwork().key, START_END_ARTWORK_KEY);
  assert.ok(!QR_ARTWORK_KEYS.includes(START_END_ARTWORK_KEY));
});

test('default assignments follow supplied order without imposing uniqueness', () => {
  assert.deepEqual(DEFAULT_QR_ARTWORK_ASSIGNMENTS, {
    access: 'galaxy', attention: 'spiral', escape: 'beam', sensory: 'human'
  });
  const duplicateAllowed = sanitizeQrArtworkAssignments({
    access: 'spiral', attention: 'spiral', escape: 'beam', sensory: 'human'
  });
  assert.equal(duplicateAllowed.access, 'spiral');
  assert.equal(duplicateAllowed.attention, 'spiral');
});

test('invalid or combined station assignments fall back safely', () => {
  const assignments = sanitizeQrArtworkAssignments({
    access: START_END_ARTWORK_KEY, attention: 'unknown', escape: 'human', sensory: 'galaxy'
  });
  assert.equal(assignments.access, 'galaxy');
  assert.equal(assignments.attention, 'spiral');
  assert.equal(assignments.escape, 'human');
  assert.equal(assignments.sensory, 'galaxy');
});

test('artwork swaps never alter authoritative station destinations', () => {
  const before = qrDestinations('https://signal.example');
  const after = qrDestinations('https://signal.example');
  const assignments = sanitizeQrArtworkAssignments({
    access: 'human', attention: 'beam', escape: 'spiral', sensory: 'galaxy'
  });
  assert.deepEqual(after.map(item => item.url), before.map(item => item.url));
  assert.equal(artworkKeyForDestination('access', assignments), 'human');
  assert.equal(artworkKeyForDestination('attention', assignments), 'beam');
});

test('Start/End ignores requested station artwork and remains combined', () => {
  assert.equal(artworkKeyForDestination('start-end', DEFAULT_QR_ARTWORK_ASSIGNMENTS, 'human'), START_END_ARTWORK_KEY);
});

test('all five approved artwork skins are present as full-resolution repository-owned PNG files', async () => {
  const files = [
    'galaxy-authorization.png', 'spiral-authorization.png', 'beam-authorization.png',
    'human-authorization.png', 'start-end-combined-authorization.png'
  ];
  for (const file of files) {
    const buffer = await fs.readFile(new URL(`../public/qr-artwork/${file}`, import.meta.url));
    assert.deepEqual([...buffer.subarray(0, 8)], [137,80,78,71,13,10,26,10], file);
    assert.equal(buffer.readUInt32BE(16), 1254, `${file} width`);
    assert.equal(buffer.readUInt32BE(20), 1254, `${file} height`);
  }
});

test('every default styled SVG carries its unchanged destination and artwork', async () => {
  const destinations = qrDestinations('https://signal.example');
  for (const destination of destinations) {
    const artworkKey = artworkKeyForDestination(destination.slug, DEFAULT_QR_ARTWORK_ASSIGNMENTS);
    const svg = await renderStyledQrSvg(renderOptions(destination, artworkKey));
    assert.match(svg, /^<svg /, destination.slug);
    assert.match(svg, /data:image\/png;base64/, destination.slug);
    assert.match(svg, /<path/, destination.slug);
    assert.match(svg, new RegExp(destination.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), destination.slug);
  }
});

test('one artwork skin can render two different authoritative station destinations', async () => {
  const [, access, attention] = qrDestinations('https://signal.example');
  const accessSvg = await renderStyledQrSvg(renderOptions(access, 'spiral'));
  const attentionSvg = await renderStyledQrSvg(renderOptions(attention, 'spiral'));
  assert.match(accessSvg, /STATION 1 \/\/ ACCESS/);
  assert.match(attentionSvg, /STATION 2 \/\/ ATTENTION/);
  assert.notEqual(access.url, attention.url);
  assert.notEqual(accessSvg, attentionSvg);
});

test('Mission Control exposes four-way selectors, browser PNG export, persistence, and fixed Start/End copy', async () => {
  const html = await fs.readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(html, /SAVE QR ARTWORK ASSIGNMENTS/);
  assert.match(html, /for\(const artwork of data\.artworkCatalog\)/);
  assert.match(html, /config\.qrArtworkAssignments/);
  assert.match(html, /destination\.slug==='start-end'/);
  assert.match(html, /FIXED ARTWORK/);
  assert.match(html, /FIXED DESTINATION/);
  assert.match(html, /downloadStyledQrPng/);
  assert.match(html, /canvas\.toBlob/);
});

test('server persists only artwork keys and renders SVG from the existing destination URL', async () => {
  const server = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /sanitizeQrArtworkAssignments/);
  assert.match(server, /qrArtworkAssignments/);
  assert.match(server, /destinationUrl: destination\.url/);
  assert.match(server, /renderStyledQrSvg/);
  assert.doesNotMatch(server, /renderStyledQrPng/);
  assert.doesNotMatch(server, /ALTER TABLE.*artwork|CREATE TABLE.*artwork/is);
});
