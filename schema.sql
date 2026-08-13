CREATE TABLE IF NOT EXISTS access_codes (
  code TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'unused' CHECK (status IN ('unused','active')),
  activated_at TIMESTAMPTZ
);

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

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
