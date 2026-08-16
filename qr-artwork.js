import fs from 'node:fs/promises';
import QRCode from 'qrcode';

const ARTWORK = Object.freeze({
  galaxy: Object.freeze({
    key: 'galaxy', label: 'GALAXY SYMBOL', publicPath: '/qr-artwork/galaxy-authorization.png',
    file: 'galaxy-authorization.png', labelMask: [420, 74, 420, 116], logoCrop: [480, 485, 296, 296]
  }),
  spiral: Object.freeze({
    key: 'spiral', label: 'SPIRAL SYMBOL', publicPath: '/qr-artwork/spiral-authorization.png',
    file: 'spiral-authorization.png', labelMask: [392, 1035, 470, 120], logoCrop: [480, 475, 296, 296]
  }),
  beam: Object.freeze({
    key: 'beam', label: 'BEAM SYMBOL', publicPath: '/qr-artwork/beam-authorization.png',
    file: 'beam-authorization.png', labelMask: [410, 68, 440, 125], logoCrop: [485, 455, 285, 350]
  }),
  human: Object.freeze({
    key: 'human', label: 'HUMAN SYMBOL', publicPath: '/qr-artwork/human-authorization.png',
    file: 'human-authorization.png', labelMask: [414, 70, 440, 125], logoCrop: [490, 490, 280, 310]
  }),
  'start-end-combined': Object.freeze({
    key: 'start-end-combined', label: 'COMBINED FOUR-SYMBOL',
    publicPath: '/qr-artwork/start-end-combined-authorization.png',
    file: 'start-end-combined-authorization.png', labelMask: null, logoCrop: [365, 350, 520, 560]
  })
});

export const QR_ARTWORK_KEYS = Object.freeze(['galaxy', 'spiral', 'beam', 'human']);
export const START_END_ARTWORK_KEY = 'start-end-combined';
export const DEFAULT_QR_ARTWORK_ASSIGNMENTS = Object.freeze({
  access: 'galaxy',
  attention: 'spiral',
  escape: 'beam',
  sensory: 'human'
});

const sourceCache = new Map();

export function qrArtworkCatalog() {
  return QR_ARTWORK_KEYS.map(key => {
    const { label, publicPath } = ARTWORK[key];
    return { key, label, publicPath };
  });
}

export function startEndArtwork() {
  const { key, label, publicPath } = ARTWORK[START_END_ARTWORK_KEY];
  return { key, label, publicPath };
}

export function sanitizeQrArtworkAssignments(value = {}, fallback = DEFAULT_QR_ARTWORK_ASSIGNMENTS) {
  return Object.fromEntries(Object.keys(DEFAULT_QR_ARTWORK_ASSIGNMENTS).map(station => {
    const candidate = String(value?.[station] || '');
    const fallbackKey = QR_ARTWORK_KEYS.includes(fallback?.[station])
      ? fallback[station]
      : DEFAULT_QR_ARTWORK_ASSIGNMENTS[station];
    return [station, QR_ARTWORK_KEYS.includes(candidate) ? candidate : fallbackKey];
  }));
}

export function artworkKeyForDestination(slug, assignments, requestedKey = '') {
  if (slug === 'start-end') return START_END_ARTWORK_KEY;
  if (QR_ARTWORK_KEYS.includes(requestedKey)) return requestedKey;
  return sanitizeQrArtworkAssignments(assignments)[slug] || DEFAULT_QR_ARTWORK_ASSIGNMENTS[slug];
}

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, character => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
  })[character]);
}

async function sourceDataUri(artwork) {
  if (!sourceCache.has(artwork.key)) {
    const fileUrl = new URL(`./public/qr-artwork/${artwork.file}`, import.meta.url);
    sourceCache.set(artwork.key, fs.readFile(fileUrl).then(buffer => `data:image/png;base64,${buffer.toString('base64')}`));
  }
  return sourceCache.get(artwork.key);
}

export async function renderStyledQrSvg({ destinationUrl, destinationLabel, artworkKey }) {
  const artwork = ARTWORK[artworkKey];
  if (!artwork) throw new Error('QR_ARTWORK_NOT_FOUND');
  const source = await sourceDataUri(artwork);
  const qr = await QRCode.toString(destinationUrl, {
    type: 'svg', width: 840, margin: 4, errorCorrectionLevel: 'H',
    color: { dark: '#000000', light: '#ffffff' }
  });
  const labelMask = artwork.labelMask
    ? `<rect x="${artwork.labelMask[0]}" y="${artwork.labelMask[1]}" width="${artwork.labelMask[2]}" height="${artwork.labelMask[3]}" rx="22" fill="#050408"/>`
    : '';
  const dynamicLabel = artwork.key === START_END_ARTWORK_KEY ? '' : `
    <rect x="377" y="72" width="500" height="112" rx="24" fill="#050408" stroke="#ff3eb5" stroke-width="4"/>
    <text x="627" y="142" text-anchor="middle" fill="#c9ff3f" font-family="monospace" font-size="29" letter-spacing="2">${escapeXml(destinationLabel)}</text>`;
  const [cropX, cropY, cropWidth, cropHeight] = artwork.logoCrop;
  const safeTitle = escapeXml(`${destinationLabel} authorization QR encoding ${destinationUrl}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1254" height="1254" viewBox="0 0 1254 1254" role="img" aria-label="${safeTitle}">
    <title>${safeTitle}</title>
    <image href="${source}" width="1254" height="1254"/>
    ${labelMask}${dynamicLabel}
    <rect x="190" y="190" width="874" height="874" rx="14" fill="#ffffff"/>
    <g transform="translate(207 207)">${qr}</g>
    <circle cx="627" cy="627" r="78" fill="#ffffff"/>
    <svg x="562" y="562" width="130" height="130" viewBox="${cropX} ${cropY} ${cropWidth} ${cropHeight}" preserveAspectRatio="xMidYMid meet">
      <image href="${source}" width="1254" height="1254"/>
    </svg>
  </svg>`;
}

