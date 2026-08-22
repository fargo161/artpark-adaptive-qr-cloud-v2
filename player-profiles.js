export const PROFILE_LIMITS = Object.freeze({ displayName: 80, contactInfo: 200, notes: 1000 });

export function normalizeProfileInput(body = {}) {
  const values = {};
  for (const [key, limit] of Object.entries(PROFILE_LIMITS)) {
    if (body[key] !== undefined && typeof body[key] !== 'string') return null;
    values[key] = String(body[key] || '').trim();
    if (values[key].length > limit) return null;
  }
  return values;
}

export function normalizeProfileSearch(value) {
  return String(value || '').trim().slice(0, 80);
}

export function publicProfile(row) {
  return {
    displayName: row?.display_name || '',
    contactInfo: row?.contact_info || '',
    notes: row?.notes || '',
    createdAt: row?.created_at || null,
    updatedAt: row?.updated_at || null
  };
}

export async function upsertPlayerProfile(client, code, profile) {
  const result = await client.query(
    `INSERT INTO player_profiles(code,display_name,contact_info,notes)
     VALUES($1,$2,$3,$4)
     ON CONFLICT (code) DO UPDATE SET display_name=EXCLUDED.display_name,
       contact_info=EXCLUDED.contact_info,notes=EXCLUDED.notes,updated_at=NOW()
     RETURNING *`,
    [code, profile.displayName, profile.contactInfo, profile.notes]
  );
  return result.rows[0];
}

export async function lockProfileAccessCode(client, code) {
  const result = await client.query('SELECT code FROM access_codes WHERE code=$1 FOR UPDATE', [code]);
  return Boolean(result.rows[0]);
}

export async function deletePlayerProfile(client, code) {
  await client.query('DELETE FROM player_profiles WHERE code=$1', [code]);
}
