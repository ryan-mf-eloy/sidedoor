# Sidedoor

Sidedoor is the local-first developer tool behind the `GatewayIPS.Tools.MockServer`
repository. It lets GatewayIPS developers inspect webhooks, simulate HTTP and
realtime providers, and exercise integration flows without changing provider
systems. Runtime state is stored in a local SQLite database.

> Last reviewed: 2026-07-29

## What it provides

- **Webhook inspection** — capture requests, inspect headers/query/body, validate
  HMAC signatures, enforce auth and rate limits, forward or transform traffic,
  replay requests, diff payloads, and export history.
- **HTTP mocks** — match method/path, return one or more response scenarios,
  apply conditional rules, add delays, and record the exact response sent.
- **Async scenario events** — send ordered, templated callbacks after a mock
  response with durable delivery state, retries, cancellation, and redacted
  history.
- **Realtime mocks and inspectors** — WebSocket, Socket.IO, and GraphQL HTTP/
  `graphql-transport-ws` sessions with ordered scripts, fixtures, and transcripts.
- **Workspaces and projects** — keep client, environment, or integration
  endpoints grouped without sharing data between workspaces.
- **Tailscale Funnel integration** — expose only the ingest listener when a
  provider must reach a local endpoint.
- **Live dashboard** — endpoint counts, traffic summaries, activity, sessions,
  and delivery updates through the admin UI and SSE.

Sidedoor is a development and test tool. It is not a production webhook gateway,
API gateway, or durable replacement for a provider's delivery system.

## Requirements

- Node.js **24 or newer** (the runtime uses the built-in `node:sqlite`).
- npm (ships with Node.js).
- Tailscale is optional and is required only for Funnel exposure.

## Quick start

```bash
git clone https://github.com/luby-fintech-br/GatewayIPS.Tools.MockServer.git
cd GatewayIPS.Tools.MockServer
npm ci
npm start
```

Open <http://127.0.0.1:4600> and create a webhook or mock. Sidedoor starts two
listeners:

| Listener | Default bind | Responsibility |
| --- | --- | --- |
| Admin (`4600`) | `127.0.0.1` | UI, REST API, SSE, and configuration |
| Ingest (`4601`) | `0.0.0.0` | Webhook/mock traffic and realtime upgrades |

Only the ingest listener is eligible for Tailscale Funnel. An endpoint is reached
by its unique slug:

```text
http://localhost:4601/<slug>
https://<machine>.<tailnet>.ts.net/<slug>  # when Funnel is enabled
```

### Useful commands

```bash
npm run dev                 # restart on source changes
npm run seed                # load generic demo workspaces and traffic
npm run reset               # clear the local database and reseed the demo data
npm run seed:oips-cielo-pix # load the GatewayIPS Cielo PIX integration fixture
npm test                    # run the complete node:test suite
```

The default database is `./sidedoor.db`. It is ignored by Git. Use
`SIDEDOOR_DB=:memory:` for an ephemeral local instance or tests.

## Using Sidedoor

### Webhooks

1. Open **Webhooks → New webhook**.
2. Choose a name and slug, then optionally configure a project, auth, HMAC
   provider, rate limit, or forwarding rules.
3. Send the provider request to `http://localhost:4601/<slug>`.
4. Inspect the captured request from the endpoint's Requests tab.

Auth supports Bearer, API key (header or query), and Basic credentials. HMAC
presets cover Stripe, GitHub, Shopify, Twilio, Slack, and custom algorithms.
Forwarding rules can forward, drop, respond, tag, or transform a request. Invalid
credentials and signatures fail closed; they never match an empty value.

Example:

```bash
curl -i -X POST http://localhost:4601/example-webhook \
  -H 'content-type: application/json' \
  -d '{"event":"checkout.completed","id":"evt_123"}'
```

### HTTP mocks

Create a mock from **Mock Servers → New mock server → HTTP API**. Configure the
method, path, default response, and optional auth. A mock accepts only its
configured method and path (or configured prefix); other methods return `405` and
other paths return `404`.

Each mock can have named response scenarios:

- **Single** always returns the active scenario.
- **Sequential** rotates through scenarios in order.
- Matching rules select a scenario by header, body field, query parameter, method,
  or path using `equals`, `contains`, `regex`, `exists`, `>`, `<`, or `≠`.

The Requests tab records the request and the response that was returned. Scenario
events run after a matched mock response, so the client response is never held
open while callbacks are delivered. Delivery runs are at-least-once, retry only
network/time-out/`408`/`425`/`429`/`5xx` failures, and redact credentials and
secret-looking fields in history.

Templates may be used in callback URLs, headers, and bodies. Common values are
`{{request.method}}`, `{{request.path}}`, `{{request.headers.<name>}}`,
`{{request.body.<field>}}`, `{{response.status}}`, `{{response.body.<field>}}`,
and `{{randomUuid}}`. Callback origins are fixed, redirects are refused, and
timeouts are bounded.

### WebSocket, Socket.IO, and GraphQL

Select **Mock Servers → New mock server** and choose a realtime protocol.

- **WebSocket** uses `ws://localhost:4601/<slug>` and an ordered script of
  expected messages/actions.
- **Socket.IO v4** uses the endpoint slug as a namespace and the fixed Engine.IO
  path `/_sidedoor/socket.io/`:

  ```js
  io('http://localhost:4601/orders', {
    path: '/_sidedoor/socket.io/',
    transports: ['websocket', 'polling'],
  });
  ```

- **GraphQL** accepts HTTP operations at the slug and subscriptions over
  `graphql-transport-ws`. Define an SDL schema and deterministic fixtures in the
  endpoint configuration.

Sessions and messages are persisted with redacted payload previews. Live sockets
are closed, not resumed, after a process restart.

### GatewayIPS Cielo PIX fixture

The repository keeps the integration fixture used by the GatewayIPS E2E suites.
Start Sidedoor, then run:

```bash
npm run seed:oips-cielo-pix
```

The seed recreates these provider-compatible mocks:

| Slug | Methods | Path prefix |
| --- | --- | --- |
| `oips-cielo-tx` | `POST`, `PUT` | `/1/sales` |
| `oips-cielo-query` | `GET` | `/1/sales/` |

Scenario markers and callback wiring are documented with the fixture source in
[`src/seed-oips-cielo-pix.js`](src/seed-oips-cielo-pix.js) and the GatewayIPS E2E
documentation. Funnel is required when the deployed service must reach the local
mock; the admin listener must remain private.

### Tailscale Funnel

Use Tailscale Funnel when an external provider or a deployed GatewayIPS service
must reach a Sidedoor endpoint running on your machine. Funnel exposes only the
ingest listener (`4601` by default); the admin UI/API (`4600`) remains local.

### Configure Tailscale

1. [Install Tailscale](https://tailscale.com/docs/install) and authenticate the
   machine with `tailscale up`.
2. Enable the prerequisites required by your tailnet (MagicDNS, HTTPS
   certificates, and permission to use Funnel). Follow the [Tailscale Funnel
   guide](https://tailscale.com/kb/1223/funnel) for the current account and
   policy settings.
3. Start Sidedoor and confirm the local ingest listener is available:

   ```bash
   npm start
   curl http://localhost:4601/
   ```

4. Enable Funnel from Sidedoor's **Tailscale** screen, or run the equivalent CLI
   commands:

   ```bash
   tailscale funnel --bg 4601
   tailscale funnel status
   ```

   The status output contains the HTTPS hostname. An endpoint is then available
   at `https://<machine>.<tailnet>.ts.net/<slug>`.

5. When the external test is complete, disable only Sidedoor's listener:

   ```bash
   tailscale funnel 4601 off
   ```

Sidedoor uses the same commands through the admin API, polls the JSON status, and
records the exposure state locally. It never runs a global `tailscale funnel
reset`, so unrelated Funnel configurations are left alone. For command flags and
version-specific behavior, see the [`tailscale funnel` CLI
reference](https://tailscale.com/docs/reference/tailscale-cli/funnel). If the
service should be reachable only by devices in your tailnet, use [Tailscale
Serve](https://tailscale.com/docs/features/tailscale-serve) instead of Funnel.

Treat a Funnel URL as public. Keep the admin port private, configure endpoint
authentication/signature validation where appropriate, and verify the public HTTP
or realtime upgrade path before running an integration test.

## Configuration

All settings are optional. Defaults keep the admin API local and the database in
the repository directory.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SIDEDOOR_HOST` | `127.0.0.1` | Admin bind host |
| `SIDEDOOR_PORT` | `4600` | Admin UI/API port |
| `SIDEDOOR_INGEST_HOST` | `0.0.0.0` | Ingest bind host |
| `SIDEDOOR_INGEST_PORT` | `4601` | Ingest/Funnel port |
| `SIDEDOOR_DB` | `./sidedoor.db` | SQLite path; `:memory:` is supported |
| `SIDEDOOR_MAX_BODY` | `5242880` | Maximum captured HTTP body in bytes |
| `SIDEDOOR_MAX_REALTIME_FRAME` | `16777216` | Process-wide realtime frame ceiling |
| `SIDEDOOR_TAILSCALE_BIN` | `tailscale` | Tailscale executable path |
| `SIDEDOOR_FUNNEL_POLL_MS` | `10000` | Funnel status poll interval; `0` disables |

Example:

```bash
SIDEDOOR_PORT=4700 SIDEDOOR_INGEST_PORT=4701 npm start
```

## Architecture at a glance

```text
Browser ───────► Admin server :4600 ──► REST/SSE ──► SQLite
Provider/client ► Ingest server :4601 ─► endpoint runtime ─► SQLite
Tailscale Funnel ─────────────────────► Ingest server only
```

The admin and ingest listeners share one store but have separate responsibilities:
the admin surface configures and observes endpoints, while the ingest surface
handles provider traffic. The ingest server has no admin routes.

```text
src/server.js       process entry point and listener lifecycle
src/api/             admin REST router and route handlers
src/ingest/          HTTP webhook/mock dispatch and GraphQL HTTP
src/lib/             auth, HMAC, matching, validation, realtime, delivery helpers
src/realtime-hub.js  WebSocket, Socket.IO, and GraphQL WS coordination
src/store.js         SQLite persistence and migrations
public/              dependency-free browser UI
test/                unit, API, transport, persistence, and UI tests
docs/adr/            architectural decision records
```

## Admin API

The UI is a client of the localhost-only API at
`http://127.0.0.1:4600/__sd/api`. Useful starting points:

```bash
curl http://127.0.0.1:4600/__sd/api/state
curl 'http://127.0.0.1:4600/__sd/api/endpoints?protocol=http'
```

Endpoint, scenario, rule, event-run, realtime-session, GraphQL fixture, request,
replay, diff, export, Funnel, and SSE routes are defined in
[`src/api/routes.js`](src/api/routes.js). Keep the admin listener bound to
localhost unless the deployment explicitly provides equivalent access control.

## Security and data handling

- The admin API binds to localhost by default and is never Funnel-exposed.
- Auth and HMAC checks fail closed; HMAC comparisons are timing-safe.
- Callback destinations must be absolute HTTP(S) URLs without embedded
  credentials; redirects and hop-by-hop/host headers are rejected.
- Credentials, signatures, cookies, authorization headers, and sensitive JSON
  fields are redacted before delivery/realtime history is persisted.
- The SQLite file contains endpoint configuration and may contain credentials;
  keep it local and never commit it.
- Do not use Sidedoor as an internet-facing production service without adding
  authentication, access control, backups, and an operational data-retention plan.

## Testing and contribution

Install dependencies with `npm ci`, then run:

```bash
npm test
```

The `node:test` suite covers auth and HMAC providers, rate limiting, matching and
validation, SQLite migrations/cascades, the REST API, HTTP ingest, async delivery
ordering/retries/redaction/recovery, WebSocket and Socket.IO transports, GraphQL
HTTP/WS, and browser UI helpers. Tests use ephemeral ports and temporary SQLite
files; they do not require Tailscale or provider credentials.

When changing runtime behavior, update the closest test and keep the admin/ingest
boundary intact. Record a short ADR in `docs/adr/` for a new persistence model,
external dependency, or module boundary.
