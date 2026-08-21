import crypto from 'node:crypto';

export const QUICK_START_ROUTE = '/quick-start';
export const QUICK_START_UNAVAILABLE = 'QUICK START TEMPORARILY UNAVAILABLE // REPORT TO CONCIERGE';

export const QUICK_START_CANDIDATE_SQL = `
  SELECT code
  FROM access_codes
  WHERE status='unused' AND allocated_at IS NULL AND is_test=FALSE
  ORDER BY code
  FOR UPDATE SKIP LOCKED
  LIMIT 1
`;

export async function claimQuickStartCandidate(client) {
  const result = await client.query(QUICK_START_CANDIDATE_SQL);
  const code = result.rows[0]?.code || null;
  if (!code) return null;
  await client.query(
    'UPDATE access_codes SET allocated_at=COALESCE(allocated_at,NOW()) WHERE code=$1',
    [code]
  );
  return code;
}

export function normalizeQuickStartToken(value) {
  const token = String(value || '').trim();
  return /^[A-Za-z0-9_-]{20,128}$/.test(token) ? token : '';
}

export function hashQuickStartToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function claimQuickStartCode(client, tokenHash) {
  await client.query(
    'INSERT INTO quick_start_claims(token_hash) VALUES($1) ON CONFLICT (token_hash) DO NOTHING',
    [tokenHash]
  );
  const existing = await client.query(
    'SELECT code FROM quick_start_claims WHERE token_hash=$1 FOR UPDATE',
    [tokenHash]
  );
  if (existing.rows[0]?.code) return { code: existing.rows[0].code, reused: true };

  const code = await claimQuickStartCandidate(client);
  if (!code) return null;
  await client.query(
    'UPDATE quick_start_claims SET code=$2,updated_at=NOW() WHERE token_hash=$1',
    [tokenHash, code]
  );
  return { code, reused: false };
}

export function isPrefetchRequest(headers = {}) {
  const purpose = `${headers.purpose || ''} ${headers['sec-purpose'] || ''}`.toLowerCase();
  return purpose.includes('prefetch') || purpose.includes('preview');
}
