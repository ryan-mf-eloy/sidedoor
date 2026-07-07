-- Sidedoor schema. Applied idempotently on boot.
-- Config for endpoint settings lives in JSON TEXT columns (parsed in the app);
-- endpoints are always fetched by id, so blobs keep the schema simple and solid.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  icon       TEXT NOT NULL DEFAULT 'box',
  color      TEXT NOT NULL DEFAULT '#edecec',
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS endpoints (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
  type           TEXT NOT NULL CHECK (type IN ('inspector','mock')),
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  method         TEXT,                         -- mock: primary method
  path           TEXT,                         -- mock: display/match path
  mode           TEXT NOT NULL DEFAULT 'single' CHECK (mode IN ('single','sequence')),
  forward_target TEXT,                         -- inspector: optional local relay URL
  seq_cursor     INTEGER NOT NULL DEFAULT 0,   -- mock sequence rotation
  config_auth    TEXT,                         -- JSON
  config_hmac    TEXT,                         -- JSON
  config_rate    TEXT,                         -- JSON
  config_rules   TEXT,                         -- JSON array (forwarding rules)
  rule_match     TEXT NOT NULL DEFAULT 'all' CHECK (rule_match IN ('all','any')),
  created_at     INTEGER NOT NULL,
  last_activity  INTEGER,
  request_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_endpoints_ws   ON endpoints(workspace_id);
CREATE INDEX IF NOT EXISTS idx_endpoints_slug ON endpoints(slug);

CREATE TABLE IF NOT EXISTS scenarios (
  id           TEXT PRIMARY KEY,
  endpoint_id  TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  status       INTEGER NOT NULL DEFAULT 200,
  delay_ms     INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 0,
  headers      TEXT,                           -- JSON object
  body         TEXT,                           -- raw string (JSON or plain)
  content_type TEXT NOT NULL DEFAULT 'application/json',
  position     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_scenarios_ep ON scenarios(endpoint_id, position);

CREATE TABLE IF NOT EXISTS match_rules (
  id               TEXT PRIMARY KEY,
  endpoint_id      TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  when_field       TEXT NOT NULL CHECK (when_field IN ('header','body','query','method','path')),
  key              TEXT NOT NULL DEFAULT '',
  op               TEXT NOT NULL DEFAULT 'equals',
  value            TEXT NOT NULL DEFAULT '',
  then_scenario_id TEXT REFERENCES scenarios(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL DEFAULT 0,
  enabled          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_match_rules_ep ON match_rules(endpoint_id, position);

CREATE TABLE IF NOT EXISTS requests (
  id               TEXT PRIMARY KEY,
  endpoint_id      TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  method           TEXT NOT NULL,
  path             TEXT NOT NULL,
  status           INTEGER NOT NULL,
  ip               TEXT,
  size             INTEGER NOT NULL DEFAULT 0,
  received_at      INTEGER NOT NULL,
  event_label      TEXT,
  scenario_id      TEXT,
  content_type     TEXT,
  headers          TEXT,                        -- JSON object
  query            TEXT,                        -- JSON object
  body             TEXT,                        -- raw request body
  response_status  INTEGER,
  response_headers TEXT,                        -- JSON object
  response_body    TEXT,
  signature        TEXT CHECK (signature IN ('valid','invalid','skipped')),
  outcome          TEXT NOT NULL DEFAULT 'captured',
  note             TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_ep_seq ON requests(endpoint_id, seq);
CREATE INDEX IF NOT EXISTS idx_requests_ep_ts  ON requests(endpoint_id, received_at);

CREATE TABLE IF NOT EXISTS funnel_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  active      INTEGER NOT NULL DEFAULT 0,
  since       INTEGER,
  base_url    TEXT,
  region      TEXT,
  machine     TEXT,
  ingest_port INTEGER,
  updated_at  INTEGER,
  last_error  TEXT
);

CREATE TABLE IF NOT EXISTS funnel_history (
  id     TEXT PRIMARY KEY,
  label  TEXT NOT NULL,
  detail TEXT,
  kind   TEXT NOT NULL DEFAULT 'up' CHECK (kind IN ('up','down','error')),
  at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_funnel_history_at ON funnel_history(at DESC);
