export const DRAWING_POOL_ELIGIBLE_SQL = `
  SELECT fr.code,fr.completed_at,COALESCE(pp.display_name,'') AS display_name
  FROM final_reflections fr
  JOIN access_codes a ON a.code=fr.code
  LEFT JOIN player_profiles pp ON pp.code=fr.code
  WHERE a.is_test=FALSE
    AND ($1::boolean OR NOT EXISTS (SELECT 1 FROM prize_draws pd WHERE pd.code=fr.code))
  ORDER BY fr.completed_at DESC,fr.code ASC
`;

export const DRAWING_POOL_HISTORY_SQL = `
  SELECT pd.id,pd.code,pd.operator,pd.allow_repeat,pd.drawn_at,
    COALESCE(pp.display_name,'') AS display_name
  FROM prize_draws pd
  LEFT JOIN player_profiles pp ON pp.code=pd.code
  ORDER BY pd.drawn_at DESC,pd.id DESC
`;

export const DRAWING_POOL_EXPORT_SQL = `
  SELECT fr.code,COALESCE(pp.display_name,'') AS display_name,fr.completed_at,
    EXISTS (SELECT 1 FROM prize_draws pd WHERE pd.code=fr.code) AS previous_winner
  FROM final_reflections fr
  JOIN access_codes a ON a.code=fr.code
  LEFT JOIN player_profiles pp ON pp.code=fr.code
  WHERE a.is_test=FALSE
    AND ($1::boolean OR NOT EXISTS (SELECT 1 FROM prize_draws pd WHERE pd.code=fr.code))
  ORDER BY fr.completed_at DESC,fr.code ASC
`;

export const DRAWING_POOL_RANDOM_SQL = `
  SELECT fr.code
  FROM final_reflections fr
  JOIN access_codes a ON a.code=fr.code
  WHERE a.is_test=FALSE
    AND ($1::boolean OR NOT EXISTS (SELECT 1 FROM prize_draws pd WHERE pd.code=fr.code))
  ORDER BY RANDOM()
  LIMIT 1
`;

export async function drawPrizeWinner(client, allowRepeat, operator) {
  if (!allowRepeat) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('artpark_drawing_pool_no_repeat'))");
  }
  const candidate = await client.query(DRAWING_POOL_RANDOM_SQL, [allowRepeat]);
  const code = candidate.rows[0]?.code;
  if (!code) return null;
  const inserted = await client.query(
    `INSERT INTO prize_draws(code,operator,allow_repeat)
     VALUES($1,$2,$3)
     RETURNING id,code,operator,allow_repeat,drawn_at`,
    [code, operator, allowRepeat]
  );
  return inserted.rows[0];
}

export function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
