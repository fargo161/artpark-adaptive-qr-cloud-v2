export const STATIONS = ['escape', 'attention', 'access', 'sensory'];

export function normalizeStation(value) {
  const station = String(value || '').toLowerCase().trim();
  return STATIONS.includes(station) ? station : null;
}

export function normalizeAccessCode(value) {
  const code = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length === 6 ? code : '';
}

export function formatAccessCode(value) {
  const code = normalizeAccessCode(value);
  return code ? `${code.slice(0, 3)}-${code.slice(3)}` : '';
}

export function nextStageFromVisits(visits) {
  const unique = new Set((visits || []).map(v => v.station));
  return Math.min(unique.size + 1, 4);
}

export function publicVisits(rows) {
  return [...rows]
    .sort((a, b) => Number(a.stage) - Number(b.stage))
    .map(row => ({
      station: row.station,
      stage: Number(row.stage),
      createdAt: row.created_at || row.createdAt || null
    }));
}

export function safeConfigForPlayer(config) {
  return {
    eventName: config.eventName,
    locked: config.locked,
    stations: config.stations,
    stages: config.stages
  };
}
