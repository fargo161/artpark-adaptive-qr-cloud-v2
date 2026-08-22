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

export function normalizeFinalPlayerName(value) {
  if (typeof value !== 'string') return { error: 'NAME_REQUIRED' };
  const name = value.trim();
  if (!name) return { error: 'NAME_REQUIRED' };
  if (name.length > PROFILE_LIMITS.displayName) return { error: 'NAME_TOO_LONG' };
  return { name };
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

export function publicProfileVersion(row) {
  return {
    id: Number(row.id),
    displayName: row.display_name || '',
    contactInfo: row.contact_info || '',
    notes: row.notes || '',
    operator: row.operator || 'TEAM',
    reason: row.reason,
    createdAt: row.created_at
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

export async function snapshotPlayerProfile(client, code, operator, reason) {
  const current = await client.query('SELECT * FROM player_profiles WHERE code=$1 FOR UPDATE', [code]);
  const profile = current.rows[0];
  if (!profile) return null;
  const result = await client.query(
    `INSERT INTO player_profile_versions(code,display_name,contact_info,notes,operator,reason)
     VALUES($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [code, profile.display_name, profile.contact_info, profile.notes, operator, reason]
  );
  return result.rows[0];
}

export async function savePlayerProfileWithHistory(client, code, profile, operator) {
  await snapshotPlayerProfile(client, code, operator, 'UPDATE');
  return upsertPlayerProfile(client, code, profile);
}

export async function saveFinalPlayerName(client, code, name, operator = 'PLAYER') {
  const current = await client.query('SELECT * FROM player_profiles WHERE code=$1 FOR UPDATE', [code]);
  const profile = current.rows[0];
  const previousNamePresent = Boolean(profile?.display_name);
  if (profile?.display_name === name) {
    return { profile, unchanged: true, previousNamePresent };
  }
  const saved = await savePlayerProfileWithHistory(client, code, {
    displayName: name,
    contactInfo: profile?.contact_info || '',
    notes: profile?.notes || ''
  }, operator);
  return { profile: saved, unchanged: false, previousNamePresent };
}

export async function deletePlayerProfile(client, code, operator) {
  const version = await snapshotPlayerProfile(client, code, operator, 'CLEAR');
  await client.query('DELETE FROM player_profiles WHERE code=$1', [code]);
  return version;
}

export async function restorePlayerProfileVersion(client, code, versionId, operator) {
  const stored = await client.query(
    'SELECT * FROM player_profile_versions WHERE id=$1 AND code=$2',
    [versionId, code]
  );
  const version = stored.rows[0];
  if (!version) return null;
  const replaced = await snapshotPlayerProfile(client, code, operator, 'RESTORE');
  const restored = await upsertPlayerProfile(client, code, {
    displayName: version.display_name,
    contactInfo: version.contact_info,
    notes: version.notes
  });
  return { restored, currentProfileExisted: Boolean(replaced) };
}
