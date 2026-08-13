import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, migrate, withTransaction, healthCheck } from './db.js';
import {
  MISSION_COOKIE,
  MISSION_SESSION_SECONDS,
  TEST_CODES,
  secureEqual,
  newSessionToken,
  hashSessionToken,
  normalizeOperator,
  validRepairRoute,
  activeDirectoryPage
} from './mission-control.js';
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
const MISSION_CONTROL_PASSPHRASE = process.env.MISSION_CONTROL_PASSPHRASE || '';
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

function setMissionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${MISSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${MISSION_SESSION_SECONDS}; HttpOnly; SameSite=Strict${secure}`);
}

function clearMissionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${MISSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure}`);
}

function codeFromRequest(req) {
  const cookieCode = normalizeAccessCode(parseCookies(req)[COOKIE_NAME]);
  const bodyCode = normalizeAccessCode(req.body?.accessCode);
  return cookieCode || bodyCode || '';
}

async function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (ADMIN_KEY && secureEqual(key, ADMIN_KEY)) {
    req.missionOperator = 'SYSTEM';
    return next();
  }
  const token = parseCookies(req)[MISSION_COOKIE];
  if (!token) return res.status(401).json({ error: 'MISSION_CONTROL_ACCESS_REQUIRED' });
  try {
    const result = await pool.query(
      'SELECT operator FROM mission_control_sessions WHERE token_hash=$1 AND expires_at>NOW()',
      [hashSessionToken(token)]
    );
    if (!result.rows[0]) {
      clearMissionCookie(res);
      return res.status(401).json({ error: 'MISSION_CONTROL_ACCESS_REQUIRED' });
    }
    req.missionOperator = result.rows[0].operator;
    next();
  } catch (error) {
    next(error);
  }
}

async function audit(client, action, code, operator, detail = {}) {
  await client.query(
    'INSERT INTO mission_control_audit(action,code,operator,detail) VALUES($1,$2,$3,$4::jsonb)',
    [action, code || null, normalizeOperator(operator), JSON.stringify(detail)]
  );
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
  const access = await client.query('SELECT code,status,allocated_at,activated_at,is_test FROM access_codes WHERE code=$1', [code]);
  if (!access.rows[0]) return null;
  const player = await client.query('SELECT code, created_at, updated_at FROM players WHERE code=$1', [code]);
  const visits = await client.query('SELECT station, stage, created_at FROM visits WHERE code=$1 ORDER BY stage', [code]);
  const complete = visits.rows.length >= 4;
  return {
    accessCode: formatAccessCode(code),
    status: complete ? 'complete' : access.rows[0].status,
    active: access.rows[0].status === 'active',
    test: access.rows[0].is_test,
    visits: publicVisits(visits.rows),
    complete,
    allocatedAt: access.rows[0].allocated_at,
    activatedAt: access.rows[0].activated_at,
    createdAt: player.rows[0]?.created_at || null,
    updatedAt: player.rows[0]?.updated_at || null
  };
}

async function authorizeCode(rawCode, res) {
  const code = normalizeAccessCode(rawCode);
  if (!code) return { ok: false, status: 400, error: 'ACCESS_CODE_REQUIRED' };

  const result = await withTransaction(async client => {
    const valid = await client.query('SELECT code, status FROM access_codes WHERE code=$1 FOR UPDATE', [code]);
    if (!valid.rows[0]) return { ok: false, status: 403, error: 'ACCESS_CODE_INVALID' };

    const existing = await client.query('SELECT code FROM players WHERE code=$1', [code]);
    const newlyActivated = valid.rows[0].status !== 'active';
    if (!existing.rows[0]) {
      await client.query('INSERT INTO players(code) VALUES($1)', [code]);
    }
    await client.query("UPDATE access_codes SET status='active', activated_at=NOW() WHERE code=$1", [code]);
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
  if (!player?.active) {
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
  const bodyCode = normalizeAccessCode(req.body?.accessCode);
  const code = codeFromRequest(req);
  if (!code) return res.status(401).json({ error: 'ACCESS_REQUIRED' });

  try {
    const result = await withTransaction(async client => {
      const valid = await client.query('SELECT code,status FROM access_codes WHERE code=$1', [code]);
      if (!valid.rows[0]) return { error: 'ACCESS_CODE_INVALID', status: 403 };
      if (!bodyCode && valid.rows[0].status !== 'active') return { error: 'ACCESS_REQUIRED', status: 401 };

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

app.post('/api/mission-control/login', async (req, res) => {
  if (!MISSION_CONTROL_PASSPHRASE) return res.status(503).json({ error: 'MISSION_CONTROL_NOT_CONFIGURED' });
  if (!secureEqual(req.body?.passphrase, MISSION_CONTROL_PASSPHRASE)) {
    return res.status(403).json({ error: 'PASSPHRASE_REJECTED' });
  }
  const token = newSessionToken();
  const operator = normalizeOperator(req.body?.operator);
  await pool.query('DELETE FROM mission_control_sessions WHERE expires_at<=NOW()');
  await pool.query(
    "INSERT INTO mission_control_sessions(token_hash,operator,expires_at) VALUES($1,$2,NOW()+($3 * INTERVAL '1 second'))",
    [hashSessionToken(token), operator, MISSION_SESSION_SECONDS]
  );
  setMissionCookie(res, token);
  res.json({ ok: true, operator });
});

app.get('/api/mission-control/session', requireAdmin, (req, res) => {
  res.json({ authenticated: true, operator: req.missionOperator });
});

app.post('/api/mission-control/logout', async (req, res) => {
  const token = parseCookies(req)[MISSION_COOKIE];
  if (token) await pool.query('DELETE FROM mission_control_sessions WHERE token_hash=$1', [hashSessionToken(token)]);
  clearMissionCookie(res);
  res.json({ ok: true });
});

app.get('/api/admin/summary', requireAdmin, async (_req, res) => {
  const [inventory, complete, stationCounts, recent] = await Promise.all([
    pool.query("SELECT status,COUNT(*)::int AS count FROM access_codes WHERE is_test=FALSE GROUP BY status"),
    pool.query('SELECT COUNT(*)::int AS count FROM (SELECT v.code FROM visits v JOIN access_codes a ON a.code=v.code WHERE a.is_test=FALSE GROUP BY v.code HAVING COUNT(*)=4) q'),
    pool.query('SELECT v.station,COUNT(*)::int AS count FROM visits v JOIN access_codes a ON a.code=v.code WHERE a.is_test=FALSE GROUP BY v.station'),
    pool.query('SELECT v.code,v.station,v.stage,v.created_at FROM visits v JOIN access_codes a ON a.code=v.code WHERE a.is_test=FALSE ORDER BY v.created_at DESC LIMIT 20')
  ]);
  const counts = { unused: 0, active: 0 };
  for (const row of inventory.rows) counts[row.status] = Number(row.count);
  const byStation = Object.fromEntries(STATIONS.map(s => [s, 0]));
  for (const row of stationCounts.rows) byStation[row.station] = Number(row.count);
  res.json({
    unused: counts.unused,
    activated: counts.active,
    complete: Number(complete.rows[0].count),
    byStation,
    recent: recent.rows.map(r => ({...r, accessCode: formatAccessCode(r.code)}))
  });
});

app.get('/api/admin/active-receivers', requireAdmin, async (req, res) => {
  const { sort, offset, limit } = activeDirectoryPage(req.query);
  const orderBy = {
    recent: 'last_activity DESC, a.code ASC',
    code: 'a.code ASC',
    progress: 'progress DESC, last_activity DESC, a.code ASC'
  }[sort];
  const result = await pool.query(`
    SELECT
      a.code,
      COUNT(v.id)::int AS progress,
      COALESCE(
        JSON_AGG(JSON_BUILD_OBJECT('station',v.station,'stage',v.stage) ORDER BY v.stage)
          FILTER (WHERE v.id IS NOT NULL),
        '[]'::json
      ) AS route,
      COUNT(v.id)=4 AS complete,
      GREATEST(
        COALESCE(MAX(v.created_at), '-infinity'::timestamptz),
        COALESCE(p.updated_at, '-infinity'::timestamptz),
        COALESCE(a.activated_at, '-infinity'::timestamptz)
      ) AS last_activity,
      COUNT(*) OVER()::int AS total
    FROM access_codes a
    LEFT JOIN players p ON p.code=a.code
    LEFT JOIN visits v ON v.code=a.code
    WHERE a.status='active' AND a.is_test=FALSE
    GROUP BY a.code,a.activated_at,p.updated_at
    ORDER BY ${orderBy}
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  const total = result.rows[0]?.total || 0;
  res.json({
    receivers: result.rows.map(row => ({
      accessCode: formatAccessCode(row.code),
      progress: Number(row.progress),
      route: row.route,
      complete: row.complete,
      lastActivity: row.last_activity
    })),
    total,
    offset,
    limit,
    hasMore: offset + result.rows.length < total,
    sort
  });
});

app.post('/api/admin/codes/issue', requireAdmin, async (req, res) => {
  const allocated = await withTransaction(async client => {
    const result = await client.query(
      "SELECT code FROM access_codes WHERE status='unused' AND allocated_at IS NULL AND is_test=FALSE ORDER BY code FOR UPDATE SKIP LOCKED LIMIT 1"
    );
    if (!result.rows[0]) return null;
    const code = result.rows[0].code;
    await client.query('UPDATE access_codes SET allocated_at=NOW(),activated_at=NULL WHERE code=$1', [code]);
    await audit(client, 'code_allocated', code, req.missionOperator);
    return code;
  });
  if (!allocated) return res.status(409).json({ error: 'NO_UNUSED_CODES' });
  res.status(201).json({ accessCode: formatAccessCode(allocated), status: 'unused' });
});

app.get('/api/admin/player/:accessCode', requireAdmin, async (req, res) => {
  const code = normalizeAccessCode(req.params.accessCode);
  const player = await playerRecord(code);
  if (!player) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  res.json({ player });
});

app.post('/api/admin/player/:accessCode/reset', requireAdmin, async (req, res) => {
  const code = normalizeAccessCode(req.params.accessCode);
  const exists = await pool.query('SELECT code FROM access_codes WHERE code=$1', [code]);
  if (!exists.rows[0]) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  await withTransaction(async client => {
    await client.query('SELECT code FROM access_codes WHERE code=$1 FOR UPDATE', [code]);
    await client.query('DELETE FROM visits WHERE code=$1', [code]);
    await client.query('DELETE FROM players WHERE code=$1', [code]);
    await client.query("UPDATE access_codes SET status='unused',allocated_at=NULL,activated_at=NULL WHERE code=$1", [code]);
    await audit(client, 'player_reset', code, req.missionOperator);
  });
  res.json({ player: await playerRecord(code) });
});

app.put('/api/admin/player/:accessCode/visits', requireAdmin, async (req, res) => {
  const code = normalizeAccessCode(req.params.accessCode);
  const stations = validRepairRoute(req.body?.stations, normalizeStation);
  if (!stations) return res.status(400).json({ error: 'INVALID_ROUTE' });
  const exists = await pool.query('SELECT code FROM access_codes WHERE code=$1', [code]);
  if (!exists.rows[0]) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  await withTransaction(async client => {
    await client.query('SELECT code FROM access_codes WHERE code=$1 FOR UPDATE', [code]);
    await client.query('DELETE FROM visits WHERE code=$1', [code]);
    if (stations.length) {
      await client.query('INSERT INTO players(code) VALUES($1) ON CONFLICT (code) DO NOTHING', [code]);
      await client.query('SELECT code FROM players WHERE code=$1 FOR UPDATE', [code]);
      for (let i = 0; i < stations.length; i += 1) {
        await client.query('INSERT INTO visits(code,station,stage) VALUES($1,$2,$3)', [code, stations[i], i + 1]);
      }
      await client.query('UPDATE players SET updated_at=NOW() WHERE code=$1', [code]);
      await client.query("UPDATE access_codes SET status='active',activated_at=COALESCE(activated_at,NOW()) WHERE code=$1", [code]);
    } else {
      await client.query('DELETE FROM players WHERE code=$1', [code]);
      await client.query("UPDATE access_codes SET status='unused',allocated_at=NULL,activated_at=NULL WHERE code=$1", [code]);
    }
    await audit(client, 'route_repaired', code, req.missionOperator, { stations });
  });
  res.json({ player: await playerRecord(code) });
});

app.get('/api/admin/tests', requireAdmin, async (_req, res) => {
  const records = [];
  for (const code of TEST_CODES) records.push(await playerRecord(code));
  res.json({ tests: records });
});

app.post('/api/admin/tests/:accessCode/open', requireAdmin, async (req, res) => {
  const code = normalizeAccessCode(req.params.accessCode);
  if (!TEST_CODES.includes(code)) return res.status(404).json({ error: 'TEST_CODE_NOT_FOUND' });
  setPlayerCookie(res, code);
  res.json({ accessCode: formatAccessCode(code), url: '/s/escape' });
});

app.post('/api/admin/tests/:accessCode/reset', requireAdmin, async (req, res) => {
  const code = normalizeAccessCode(req.params.accessCode);
  if (!TEST_CODES.includes(code)) return res.status(404).json({ error: 'TEST_CODE_NOT_FOUND' });
  await withTransaction(async client => {
    await client.query('SELECT code FROM access_codes WHERE code=$1 AND is_test=TRUE FOR UPDATE', [code]);
    await client.query('DELETE FROM visits WHERE code=$1', [code]);
    await client.query('DELETE FROM players WHERE code=$1', [code]);
    await client.query("UPDATE access_codes SET status='unused',allocated_at=NULL,activated_at=NULL WHERE code=$1 AND is_test=TRUE", [code]);
    await audit(client, 'test_reset', code, req.missionOperator);
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
