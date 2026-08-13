import crypto from 'node:crypto';

export const MISSION_COOKIE = 'artpark_mission_control';
export const MISSION_SESSION_SECONDS = 60 * 60 * 12;
export const TEST_CODES = ['TEST01', 'TEST02', 'TEST03', 'TEST04', 'TEST05'];

export function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

export function normalizeOperator(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 40) || 'TEAM';
}

export function validRepairRoute(values, normalizeStation) {
  if (!Array.isArray(values) || values.length > 4) return null;
  const stations = values.map(normalizeStation);
  if (stations.some(value => !value) || new Set(stations).size !== stations.length) return null;
  return stations;
}
