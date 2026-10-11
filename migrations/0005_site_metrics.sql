-- Identity-free product metrics. No changes to community or submission tables.
CREATE TABLE site_metric_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  started_day TEXT
);
INSERT INTO site_metric_meta (singleton, schema_version, started_day) VALUES (1, 1, NULL);

CREATE TABLE site_metric_counts (
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  detail TEXT NOT NULL,
  event_count INTEGER NOT NULL CHECK (event_count > 0),
  PRIMARY KEY (day, name, detail)
) WITHOUT ROWID;

-- One global bucket per minute. No IP/device/session/batch identifier.
CREATE TABLE site_metric_rate (
  window_start INTEGER PRIMARY KEY,
  request_count INTEGER NOT NULL CHECK (request_count BETWEEN 1 AND 241),
  expires_at INTEGER NOT NULL
);
CREATE INDEX site_metric_rate_expiry ON site_metric_rate (expires_at);
