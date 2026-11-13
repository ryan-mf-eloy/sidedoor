// Central configuration, resolved from environment with sensible defaults.
// Everything is overridable so tests can boot isolated instances.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? n : dflt;
}

export function loadConfig(overrides = {}) {
  const env = process.env;
  return {
    // Admin UI + REST API — bound to localhost only, never funnelled.
    adminHost: env.SIDEDOOR_HOST || '127.0.0.1',
    adminPort: int(env.SIDEDOOR_PORT, 4600),

    // Ingest runtime — the only surface Tailscale Funnel exposes.
    ingestHost: env.SIDEDOOR_INGEST_HOST || '0.0.0.0',
    ingestPort: int(env.SIDEDOOR_INGEST_PORT, 4601),

    // SQLite database file. ':memory:' for ephemeral/test instances.
    dbPath: env.SIDEDOOR_DB || join(ROOT, 'sidedoor.db'),

    // Static assets (the SPA).
    publicDir: join(ROOT, 'public'),

    // Max ingest body captured (bytes). Larger requests get 413.
    maxBodyBytes: int(env.SIDEDOOR_MAX_BODY, 5 * 1024 * 1024),

    // Absolute process-wide WebSocket/Socket.IO frame ceiling. Individual
    // endpoints can only choose a smaller value in their realtime settings.
    maxRealtimeFrameBytes: int(env.SIDEDOOR_MAX_REALTIME_FRAME, 16 * 1024 * 1024),

    // Path to the tailscale CLI.
    tailscaleBin: env.SIDEDOOR_TAILSCALE_BIN || 'tailscale',

    // Background funnel-status poll interval (ms). 0 disables polling.
    funnelPollMs: int(env.SIDEDOOR_FUNNEL_POLL_MS, 10000),

    root: ROOT,
    ...overrides,
  };
}

// The public base host shown for endpoint URLs when the funnel is off:
// a plain localhost origin pointing at the ingest port.
export function localBase(config) {
  const host = config.ingestHost === '0.0.0.0' ? 'localhost' : config.ingestHost;
  return `http://${host}:${config.ingestPort}`;
}
