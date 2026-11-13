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
  protocol       TEXT NOT NULL DEFAULT 'http' CHECK (protocol IN ('http','websocket','socketio','graphql')),
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  method         TEXT,                         -- mock: primary method (legacy single)
  path           TEXT,                         -- mock: display/match path
  path_mode      TEXT NOT NULL DEFAULT 'exact' CHECK (path_mode IN ('exact','prefix')),
  allowed_methods TEXT,                        -- JSON array; null = use method column only
  mode           TEXT NOT NULL DEFAULT 'single' CHECK (mode IN ('single','sequence')),
  forward_target TEXT,                         -- inspector: optional local relay URL
  seq_cursor     INTEGER NOT NULL DEFAULT 0,   -- mock sequence rotation
  config_auth    TEXT,                         -- JSON
  config_hmac    TEXT,                         -- JSON
  config_rate    TEXT,                         -- JSON
  config_realtime TEXT,                        -- JSON: limits, origins and realtime auth source
  config_rules   TEXT,                         -- JSON array (forwarding rules)
  rule_match     TEXT NOT NULL DEFAULT 'all' CHECK (rule_match IN ('all','any')),
  created_at     INTEGER NOT NULL,
  last_activity  INTEGER,
  request_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_endpoints_ws   ON endpoints(workspace_id);
CREATE INDEX IF NOT EXISTS idx_endpoints_slug ON endpoints(slug);
CREATE INDEX IF NOT EXISTS idx_endpoints_protocol ON endpoints(protocol);

-- Long-lived inbound connections are intentionally separate from HTTP
-- requests. A session is historical once closed; live sockets are never
-- resumed after a process restart.
CREATE TABLE IF NOT EXISTS realtime_sessions (
  id                    TEXT PRIMARY KEY,
  endpoint_id           TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  protocol              TEXT NOT NULL CHECK (protocol IN ('websocket','socketio','graphql')),
  transport             TEXT NOT NULL,
  source                TEXT NOT NULL DEFAULT 'ingest' CHECK (source IN ('ingest','test')),
  state                 TEXT NOT NULL DEFAULT 'connected' CHECK (state IN ('connected','closed','rejected')),
  remote_ip             TEXT,
  headers               TEXT,
  connected_at          INTEGER NOT NULL,
  closed_at             INTEGER,
  close_code            INTEGER,
  close_reason          TEXT,
  message_count         INTEGER NOT NULL DEFAULT 0,
  dropped_message_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_realtime_sessions_endpoint ON realtime_sessions(endpoint_id, connected_at DESC);
CREATE INDEX IF NOT EXISTS idx_realtime_sessions_open ON realtime_sessions(state, endpoint_id);

CREATE TABLE IF NOT EXISTS realtime_messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES realtime_sessions(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('in','out','system')),
  kind          TEXT NOT NULL,
  event_name    TEXT,
  operation_name TEXT,
  payload       TEXT,
  payload_size  INTEGER NOT NULL DEFAULT 0,
  truncated     INTEGER NOT NULL DEFAULT 0,
  at            INTEGER NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_realtime_messages_session ON realtime_messages(session_id, seq);

-- Stateful mock conversations. A script owns initial actions, and its ordered
-- steps describe what a client may send and what Sidedoor sends in response.
CREATE TABLE IF NOT EXISTS realtime_scripts (
  id              TEXT PRIMARY KEY,
  endpoint_id     TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  position        INTEGER NOT NULL DEFAULT 0,
  connect_actions TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_realtime_scripts_endpoint ON realtime_scripts(endpoint_id, position);

CREATE TABLE IF NOT EXISTS realtime_script_steps (
  id           TEXT PRIMARY KEY,
  script_id    TEXT NOT NULL REFERENCES realtime_scripts(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  match_config TEXT NOT NULL,
  actions      TEXT NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_realtime_script_steps_script ON realtime_script_steps(script_id, position);

-- A GraphQL endpoint owns one SDL document and a collection of deterministic
-- fixtures. Fixtures avoid executable user code: all responses are data.
CREATE TABLE IF NOT EXISTS graphql_schemas (
  endpoint_id TEXT PRIMARY KEY REFERENCES endpoints(id) ON DELETE CASCADE,
  sdl         TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS graphql_fixtures (
  id                  TEXT PRIMARY KEY,
  endpoint_id         TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  operation_name      TEXT,
  document_hash       TEXT,
  operation_type      TEXT NOT NULL DEFAULT 'query' CHECK (operation_type IN ('query','mutation','subscription')),
  variables_match     TEXT,
  response            TEXT NOT NULL DEFAULT '{}',
  subscription_events TEXT NOT NULL DEFAULT '[]',
  delay_ms            INTEGER NOT NULL DEFAULT 0,
  enabled             INTEGER NOT NULL DEFAULT 1,
  position            INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graphql_fixtures_endpoint ON graphql_fixtures(endpoint_id, position);

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

-- Async callbacks configured on individual mock response scenarios. Request
-- and schedule settings are JSON so the runtime can snapshot a complete
-- immutable configuration when a valid mock call is handled.
CREATE TABLE IF NOT EXISTS scenario_events (
  id             TEXT PRIMARY KEY,
  scenario_id    TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  position       INTEGER NOT NULL DEFAULT 0,
  request_config TEXT NOT NULL,
  schedule_config TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scenario_events_scenario ON scenario_events(scenario_id, position);

-- A run is an immutable snapshot created only after a mock successfully
-- responds. Jobs model one intentional delivery; attempts model its retries.
-- Their cascade chain makes endpoint deletion remove all delivery history.
CREATE TABLE IF NOT EXISTS event_runs (
  id              TEXT PRIMARY KEY,
  endpoint_id     TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  scenario_id     TEXT REFERENCES scenarios(id) ON DELETE SET NULL,
  request_id      TEXT REFERENCES requests(id) ON DELETE SET NULL,
  source          TEXT NOT NULL CHECK (source IN ('ingest','test')),
  status          TEXT NOT NULL CHECK (status IN ('scheduled','running','completed','completed_with_failures','cancelled')),
  context         TEXT NOT NULL,
  events_snapshot TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  finished_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_event_runs_endpoint ON event_runs(endpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_runs_scenario ON event_runs(scenario_id, created_at DESC);

CREATE TABLE IF NOT EXISTS event_jobs (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES event_runs(id) ON DELETE CASCADE,
  event_id         TEXT NOT NULL,
  event_name       TEXT NOT NULL,
  position         INTEGER NOT NULL,
  sequence_index   INTEGER NOT NULL,
  repeat_index     INTEGER NOT NULL DEFAULT 0,
  delay_before_ms  INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL CHECK (status IN ('blocked','scheduled','running','succeeded','failed','cancelled')),
  scheduled_at     INTEGER,
  started_at       INTEGER,
  finished_at      INTEGER,
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  response_status  INTEGER,
  last_error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_jobs_due ON event_jobs(status, scheduled_at, sequence_index);
CREATE INDEX IF NOT EXISTS idx_event_jobs_run ON event_jobs(run_id, sequence_index);
CREATE INDEX IF NOT EXISTS idx_event_jobs_event ON event_jobs(event_id, status);

CREATE TABLE IF NOT EXISTS event_attempts (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES event_jobs(id) ON DELETE CASCADE,
  attempt_no       INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('succeeded','failed','configuration','cancelled')),
  request_url      TEXT,
  request_method   TEXT,
  response_status  INTEGER,
  response_headers TEXT,
  response_body    TEXT,
  error            TEXT,
  duration_ms      INTEGER NOT NULL DEFAULT 0,
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_attempts_job_no ON event_attempts(job_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_event_attempts_job ON event_attempts(job_id, attempt_no);

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
