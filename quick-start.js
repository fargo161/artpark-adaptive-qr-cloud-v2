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

export function isPrefetchRequest(headers = {}) {
  const purpose = `${headers.purpose || ''} ${headers['sec-purpose'] || ''}`.toLowerCase();
  return purpose.includes('prefetch') || purpose.includes('preview');
}
