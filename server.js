import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, migrate, withTransaction, healthCheck } from './db.js';
import {
  STATIONS,
  STATION_ROUTES,
  normalizeStation,
  normalizeAccessCode,
  formatAccessCode,
  publicVisits,
  safeConfigForPlayer
} from './lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const COOKIE_NAME = 'artpark_field_access';
const ONE_YEAR = 60 * 60 * 24 * 365;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. See .env.example.');
  process.exit(1);
}
if (!ADMIN_KEY) {
  console.error('ADMIN_KEY is required. See .env.example.');
  process.exit(1);
}

app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = decodeURIComponent(part.slice(idx + 1).trim());
    if (key) out[key] = value;
  }
  return out;
}

function setPlayerCookie(res, code) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(code)}; Path=/; Max-Age=${ONE_YEAR}; HttpOnly; SameSite=Lax${secure}`);
}

function clearPlayerCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
}

function codeFromRequest(req) {
  const cookieCode = normalizeAccessCode(parseCookies(req)[COOKIE_NAME]);
  const bodyCode = normalizeAccessCode(req.body?.accessCode);
  return cookieCode || bodyCode || '';
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(403).json({ error: 'FORBIDDEN' });
  next();
}

async function getDefaultConfig() {
  return JSON.parse(await fs.readFile(path.join(__dirname, 'config.default.json'), 'utf8'));
}

async function getContentConfig(client = pool) {
  const result = await client.query("SELECT value FROM app_settings WHERE key='content_config'");
  if (result.rows[0]?.value) return result.rows[0].value;
  const defaults = await getDefaultConfig();
  await client.query(
    "INSERT INTO app_settings(key,value) VALUES('content_config',$1::jsonb) ON CONFLICT (key) DO NOTHING",
    [JSON.stringify(defaults)]
  );
  return defaults;
}

async function setContentConfig(value) {
  await pool.query(
    "INSERT INTO app_settings(key,value,updated_at) VALUES('content_config',$1::jsonb,NOW()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()",
    [JSON.stringify(value)]
  );
}

async function playerRecord(code, client = pool) {
  const player = await client.query('SELECT code, created_at, updated_at FROM players WHERE code=$1', [code]);
  if (!player.rows[0]) return null;
  const visits = await client.query('SELECT station, stage, created_at FROM visits WHERE code=$1 ORDER BY stage', [code]);
  return {
    accessCode: formatAccessCode(code),
    visits: publicVisits(visits.rows),
    complete: visits.rows.length >= 4,
    createdAt: player.rows[0].created_at,
    updatedAt: player.rows[0].updated_at
  };
}

async function authorizeCode(rawCode, res) {
  const code = normalizeAccessCode(rawCode);
  if (!code) return { ok: false, status: 400, error: 'ACCESS_CODE_REQUIRED' };

  const result = await withTransaction(async client => {
    const valid = await client.query('SELECT code, status FROM access_codes WHERE code=$1 FOR UPDATE', [code]);
    if (!valid.rows[0]) return { ok: false, status: 403, error: 'ACCESS_CODE_INVALID' };

    const existing = await client.query('SELECT code FROM players WHERE code=$1', [code]);
    let newlyActivated = false;
    if (!existing.rows[0]) {
      await client.query('INSERT INTO players(code) VALUES($1)', [code]);
      await client.query("UPDATE access_codes SET status='active', activated_at=COALESCE(activated_at,NOW()) WHERE code=$1", [code]);
      newlyActivated = true;
    }
    const player = await playerRecord(code, client);
    return { ok: true, player, newlyActivated };
  });

  if (result.ok) setPlayerCookie(res, code);
  return result;
}

app.get('/healthz', async (_req, res) => {
  try {
    const dbTime = await healthCheck();
    res.json({ ok: true, database: true, time: dbTime });
  } catch (error) {
    res.status(503).json({ ok: false, database: false, error: error.message });
  }
});

app.get('/api/config', async (_req, res) => {
  const config = await getContentConfig();
  res.json(safeConfigForPlayer(config));
});

app.get('/api/me', async (req, res) => {
  const code = normalizeAccessCode(parseCookies(req)[COOKIE_NAME]);
  if (!code) return res.status(401).json({ error: 'ACCESS_REQUIRED' });
  const player = await playerRecord(code);
  if (!player) {
    clearPlayerCookie(res);
    return res.status(401).json({ error: 'ACCESS_REQUIRED' });
  }
  res.json({ player });
});

app.post('/api/access', async (req, res) => {
  const result = await authorizeCode(req.body?.accessCode, res);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.status(result.newlyActivated ? 201 : 200).json({
    player: result.player,
    newlyActivated: result.newlyActivated
  });
});

app.post('/api/logout', (_req, res) => {
  clearPlayerCookie(res);
  res.json({ ok: true });
});

app.post('/api/scan/:station', async (req, res) => {
  const station = normalizeStation(req.params.station);
  if (!station) return res.status(400).json({ error: 'INVALID_STATION' });
  const code = codeFromRequest(req);
  if (!code) return res.status(401).json({ error: 'ACCESS_REQUIRED' });

  try {
    const result = await withTransaction(async client => {
      const valid = await client.query('SELECT code FROM access_codes WHERE code=$1', [code]);
      if (!valid.rows[0]) return { error: 'ACCESS_CODE_INVALID', status: 403 };

      await client.query('INSERT INTO players(code) VALUES($1) ON CONFLICT (code) DO NOTHING', [code]);
      await client.query("UPDATE access_codes SET status='active', activated_at=COALESCE(activated_at,NOW()) WHERE code=$1", [code]);
      await client.query('SELECT code FROM players WHERE code=$1 FOR UPDATE', [code]);

      const existing = await client.query('SELECT station, stage, created_at FROM visits WHERE code=$1 AND station=$2', [code, station]);
      let stage;
      let duplicate = false;
      if (existing.rows[0]) {
        stage = Number(existing.rows[0].stage);
        duplicate = true;
      } else {
        const count = await client.query('SELECT COUNT(*)::int AS count FROM visits WHERE code=$1', [code]);
        stage = Math.min(Number(count.rows[0].count) + 1, 4);
        await client.query('INSERT INTO visits(code,station,stage) VALUES($1,$2,$3)', [code, station, stage]);
        await client.query('UPDATE players SET updated_at=NOW() WHERE code=$1', [code]);
      }

      const config = await getContentConfig(client);
      const player = await playerRecord(code, client);
      return {
        player,
        station,
        stationMeta: config.stations[station],
        stage,
        stageMeta: config.stages[String(stage)],
        duplicate,
        videoUrl: config.videos?.[station]?.[String(stage)] || ''
      };
    });

    if (result.error) return res.status(result.status).json({ error: result.error });
    setPlayerCookie(res, code);
    res.json(result);
  } catch (error) {
    console.error('scan error', error);
    res.status(503).json({ error: 'SIGNAL_TEMPORARILY_UNAVAILABLE', retryable: true });
  }
});

app.get(STATION_ROUTES, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'station.html'));
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/admin/summary', requireAdmin, async (_req, res) => {
  const [activated, complete, stationCounts, recent] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS count FROM players'),
    pool.query('SELECT COUNT(*)::int AS count FROM (SELECT code FROM visits GROUP BY code HAVING COUNT(*)=4) q'),
    pool.query('SELECT station, COUNT(*)::int AS count FROM visits GROUP BY station'),
    pool.query('SELECT code, station, stage, created_at FROM visits ORDER BY created_at DESC LIMIT 20')
  ]);
  const byStation = Object.fromEntries(STATIONS.map(s => [s, 0]));
  for (const row of stationCounts.rows) byStation[row.station] = Number(row.count);
  res.json({
    activated: Number(activated.rows[0].count),
    complete: Number(complete.rows[0].count),
    byStation,
    recent: recent.rows.map(r => ({...r, accessCode: formatAccessCode(r.code)}))
  });
});

app.get('/api/admin/player/:accessCode', requireAdmin, async (req, res) => {
  const code = normalizeAccessCode(req.params.accessCode);
  const player = await playerRecord(code);
  if (!player) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  res.json({ player });
});

app.post('/api/admin/player/:accessCode/reset', requireAdmin, async (req, res) => {
  const code = normalizeAccessCode(req.params.accessCode);
  const exists = await pool.query('SELECT code FROM players WHERE code=$1', [code]);
  if (!exists.rows[0]) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  await withTransaction(async client => {
    await client.query('DELETE FROM visits WHERE code=$1', [code]);
    await client.query('UPDATE players SET updated_at=NOW() WHERE code=$1', [code]);
  });
  res.json({ player: await playerRecord(code) });
});

app.put('/api/admin/player/:accessCode/visits', requireAdmin, async (req, res) => {
  const code = normalizeAccessCode(req.params.accessCode);
  const stations = Array.isArray(req.body?.stations) ? req.body.stations.map(normalizeStation) : [];
  if (stations.some(v => !v) || new Set(stations).size !== stations.length || stations.length > 4) {
    return res.status(400).json({ error: 'INVALID_ROUTE' });
  }
  const exists = await pool.query('SELECT code FROM players WHERE code=$1', [code]);
  if (!exists.rows[0]) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  await withTransaction(async client => {
    await client.query('SELECT code FROM players WHERE code=$1 FOR UPDATE', [code]);
    await client.query('DELETE FROM visits WHERE code=$1', [code]);
    for (let i = 0; i < stations.length; i += 1) {
      await client.query('INSERT INTO visits(code,station,stage) VALUES($1,$2,$3)', [code, stations[i], i + 1]);
    }
    await client.query('UPDATE players SET updated_at=NOW() WHERE code=$1', [code]);
  });
  res.json({ player: await playerRecord(code) });
});

app.get('/api/admin/config', requireAdmin, async (_req, res) => {
  res.json(await getContentConfig());
});

app.put('/api/admin/config', requireAdmin, async (req, res) => {
  const current = await getContentConfig();
  const next = req.body;
  if (!next || typeof next !== 'object' || !next.videos || !next.locked) {
    return res.status(400).json({ error: 'INVALID_CONFIG' });
  }
  // Preserve core station/stage metadata if the admin editor omits it.
  const merged = {
    ...current,
    ...next,
    stations: next.stations || current.stations,
    stages: next.stages || current.stages
  };
  await setContentConfig(merged);
  res.json(merged);
});

async function start() {
  await migrate();
  await getContentConfig();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ARTPARK cloud router v2 running on port ${PORT}`);
  });
}

start().catch(error => {
  console.error(error);
  process.exit(1);
});
