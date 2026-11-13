// SQLite connection via node:sqlite. Opens a database, applies pragmas and the
// schema idempotently, and guarantees baseline rows exist.
import './lib/quiet.js';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newId, slugify } from './lib/ids.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
const SCHEMA_VERSION = '5';

export function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  // Migrations run against whatever pre-existing tables a database file
  // already has, BEFORE the idempotent schema.sql bootstrap below (which
  // only ever CREATEs TABLE IF NOT EXISTS, so it can't widen a constraint on
  // a table that already exists with the old shape).
  migrateMatchRulesV2(db);
  migrateEndpointPathMode(db);
  migrateRealtimeV5(db);

  db.exec(SCHEMA);

  db.prepare(
    'INSERT INTO meta(key,value) VALUES(?,?) ' +
    'ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run('schema_version', SCHEMA_VERSION);

  ensureDefaults(db);
  return db;
}

// v1 -> v2: match_rules.when_field only allowed header/body/query, and had no
// enabled flag. SQLite can't ALTER a CHECK constraint directly, so an
// existing table is rebuilt (create-new, copy, drop, rename) inside one
// transaction — atomic, and a no-op on a database that doesn't have the
// table yet (schema.sql below creates it fresh with the new shape) or that
// was already migrated.
function migrateMatchRulesV2(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='match_rules'").get();
  if (!row || row.sql.includes("'method'")) return; // no table yet, or already migrated
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE match_rules_v2 (
      id               TEXT PRIMARY KEY,
      endpoint_id      TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
      when_field       TEXT NOT NULL CHECK (when_field IN ('header','body','query','method','path')),
      key              TEXT NOT NULL DEFAULT '',
      op               TEXT NOT NULL DEFAULT 'equals',
      value            TEXT NOT NULL DEFAULT '',
      then_scenario_id TEXT REFERENCES scenarios(id) ON DELETE CASCADE,
      position         INTEGER NOT NULL DEFAULT 0,
      enabled          INTEGER NOT NULL DEFAULT 1
    )`);
    db.exec(
      'INSERT INTO match_rules_v2(id,endpoint_id,when_field,key,op,value,then_scenario_id,position) ' +
      'SELECT id,endpoint_id,when_field,key,op,value,then_scenario_id,position FROM match_rules'
    );
    db.exec('DROP TABLE match_rules');
    db.exec('ALTER TABLE match_rules_v2 RENAME TO match_rules');
    db.exec('CREATE INDEX IF NOT EXISTS idx_match_rules_ep ON match_rules(endpoint_id, position)');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}


function migrateEndpointPathMode(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='endpoints'").get();
  if (!table) return;
  const cols = db.prepare("PRAGMA table_info(endpoints)").all().map((r) => r.name);
  if (!cols.includes('path_mode')) {
    db.exec("ALTER TABLE endpoints ADD COLUMN path_mode TEXT NOT NULL DEFAULT 'exact'");
  }
  if (!cols.includes('allowed_methods')) {
    db.exec('ALTER TABLE endpoints ADD COLUMN allowed_methods TEXT');
  }
}

// v4 -> v5: protocol-aware endpoints retain the existing `type` axis
// (inspector/mock) and add an independent transport axis. ALTER TABLE is
// sufficient here because the new fields have safe defaults; existing HTTP
// endpoint rows therefore keep their exact runtime behavior.
function migrateRealtimeV5(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='endpoints'").get();
  if (!table) return;
  const cols = db.prepare('PRAGMA table_info(endpoints)').all().map((r) => r.name);
  if (!cols.includes('protocol')) {
    db.exec("ALTER TABLE endpoints ADD COLUMN protocol TEXT NOT NULL DEFAULT 'http'");
  }
  if (!cols.includes('config_realtime')) {
    db.exec('ALTER TABLE endpoints ADD COLUMN config_realtime TEXT');
  }
}

function ensureDefaults(db) {
  const now = Date.now();

  // At least one workspace must always exist.
  const wsCount = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n;
  if (wsCount === 0) {
    const id = newId('ws');
    db.prepare(
      'INSERT INTO workspaces(id,name,icon,color,position,created_at) VALUES(?,?,?,?,?,?)'
    ).run(id, 'Sidedoor', 'box', '#edecec', 0, now);
    setAppState(db, 'active_workspace', id);
  }

  // Singleton funnel state row.
  const fs = db.prepare('SELECT COUNT(*) AS n FROM funnel_state WHERE id=1').get().n;
  if (fs === 0) {
    db.prepare(
      'INSERT INTO funnel_state(id,active,since,base_url,region,machine,ingest_port,updated_at,last_error) ' +
      'VALUES(1,0,NULL,NULL,NULL,NULL,NULL,?,NULL)'
    ).run(now);
  }

  // Default UI prefs.
  if (getAppState(db, 'active_workspace') == null) {
    const first = db.prepare('SELECT id FROM workspaces ORDER BY position, created_at LIMIT 1').get();
    if (first) setAppState(db, 'active_workspace', first.id);
  }
  if (getAppState(db, 'sidebar_collapsed') == null) setAppState(db, 'sidebar_collapsed', '0');
}

export function getAppState(db, key) {
  const row = db.prepare('SELECT value FROM app_state WHERE key=?').get(key);
  return row ? row.value : null;
}

export function setAppState(db, key, value) {
  db.prepare(
    'INSERT INTO app_state(key,value) VALUES(?,?) ' +
    'ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(key, String(value));
}

export { SCHEMA_VERSION, slugify };
