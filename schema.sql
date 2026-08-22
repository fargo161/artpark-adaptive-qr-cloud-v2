CREATE TABLE IF NOT EXISTS access_codes (
  code TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'unused',
  activated_at TIMESTAMPTZ
);

ALTER TABLE access_codes ADD COLUMN IF NOT EXISTS allocated_at TIMESTAMPTZ;
ALTER TABLE access_codes ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='access_codes' AND column_name='issued_at'
  ) THEN
    EXECUTE 'UPDATE access_codes SET allocated_at=COALESCE(allocated_at,issued_at)';
    ALTER TABLE access_codes DROP COLUMN issued_at;
  END IF;
END $$;

UPDATE access_codes SET status='unused' WHERE status='issued';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='access_codes_status_check'
      AND conrelid='access_codes'::regclass
      AND pg_get_constraintdef(oid) LIKE '%issued%'
  ) THEN
    ALTER TABLE access_codes DROP CONSTRAINT access_codes_status_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='access_codes_status_check' AND conrelid='access_codes'::regclass
  ) THEN
    ALTER TABLE access_codes ADD CONSTRAINT access_codes_status_check CHECK (status IN ('unused','active'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS players (
  code TEXT PRIMARY KEY REFERENCES access_codes(code) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS visits (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL REFERENCES players(code) ON DELETE CASCADE,
  station TEXT NOT NULL CHECK (station IN ('escape','attention','access','sensory')),
  stage INTEGER NOT NULL CHECK (stage BETWEEN 1 AND 4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (code, station),
  UNIQUE (code, stage)
);

CREATE INDEX IF NOT EXISTS visits_station_idx ON visits(station);
CREATE INDEX IF NOT EXISTS visits_created_idx ON visits(created_at DESC);
CREATE INDEX IF NOT EXISTS access_codes_active_idx ON access_codes(code) WHERE status='active' AND is_test=FALSE;

CREATE TABLE IF NOT EXISTS video_answers (
  code TEXT NOT NULL REFERENCES players(code) ON DELETE CASCADE,
  station TEXT NOT NULL CHECK (station IN ('escape','attention','access','sensory')),
  accepted_answer TEXT NOT NULL,
  selected_choice TEXT,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (code, station)
);

ALTER TABLE video_answers ADD COLUMN IF NOT EXISTS selected_choice TEXT;
UPDATE video_answers SET selected_choice=accepted_answer WHERE selected_choice IS NULL;
ALTER TABLE video_answers ALTER COLUMN selected_choice SET NOT NULL;

CREATE INDEX IF NOT EXISTS video_answers_station_idx ON video_answers(station);

CREATE TABLE IF NOT EXISTS final_reflections (
  code TEXT PRIMARY KEY REFERENCES players(code) ON DELETE CASCADE,
  submitted_answer TEXT NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mission_control_sessions (
  token_hash TEXT PRIMARY KEY,
  operator TEXT NOT NULL DEFAULT 'TEAM',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS mission_control_sessions_expires_idx ON mission_control_sessions(expires_at);

CREATE TABLE IF NOT EXISTS quick_start_claims (
  token_hash TEXT PRIMARY KEY,
  code TEXT REFERENCES access_codes(code) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS quick_start_claims_code_idx ON quick_start_claims(code);

CREATE TABLE IF NOT EXISTS prize_draws (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL REFERENCES access_codes(code),
  operator TEXT NOT NULL DEFAULT 'TEAM',
  allow_repeat BOOLEAN NOT NULL DEFAULT FALSE,
  drawn_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS prize_draws_drawn_at_idx ON prize_draws(drawn_at DESC);
CREATE INDEX IF NOT EXISTS prize_draws_code_idx ON prize_draws(code);

CREATE TABLE IF NOT EXISTS player_profiles (
  code TEXT PRIMARY KEY REFERENCES access_codes(code) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT '',
  contact_info TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS player_profiles_display_name_idx ON player_profiles(LOWER(display_name));

CREATE TABLE IF NOT EXISTS player_profile_versions (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL REFERENCES access_codes(code) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT '',
  contact_info TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  operator TEXT NOT NULL DEFAULT 'TEAM',
  reason TEXT NOT NULL CHECK (reason IN ('UPDATE','CLEAR','RESTORE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS player_profile_versions_code_created_idx
  ON player_profile_versions(code,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS mission_control_audit (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  code TEXT,
  operator TEXT NOT NULL DEFAULT 'TEAM',
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

UPDATE access_codes a SET status='active'
WHERE EXISTS (SELECT 1 FROM players p WHERE p.code=a.code)
  AND a.activated_at IS NOT NULL
  AND a.status <> 'active';

INSERT INTO access_codes(code,status,is_test)
VALUES ('TEST01','unused',TRUE),('TEST02','unused',TRUE),('TEST03','unused',TRUE),('TEST04','unused',TRUE),('TEST05','unused',TRUE)
ON CONFLICT (code) DO UPDATE SET is_test=TRUE;
