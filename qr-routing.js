export const QR_DESTINATIONS = [
  { slug: 'start-end', name: 'START / END', route: '/s/start-end' },
  { slug: 'access', name: 'ACCESS', route: '/s/access', stationNumber: 1 },
  { slug: 'attention', name: 'ATTENTION', route: '/s/attention', stationNumber: 2 },
  { slug: 'escape', name: 'ESCAPE', route: '/s/escape', stationNumber: 3 },
  { slug: 'sensory', name: 'SENSORY', route: '/s/sensory', stationNumber: 4 }
];

export function normalizeBaseUrl(value) {
  const baseUrl = String(value || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/i.test(baseUrl)) return '';
  return baseUrl;
}

export function qrDestinations(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) throw new Error('PUBLIC_BASE_URL is not configured with a valid HTTP(S) URL');
  return QR_DESTINATIONS.map(destination => ({
    ...destination,
    url: `${normalized}${destination.route}`
  }));
}
