# Sidedoor

A local-first developer tool for **webhook inspection** and **API mocking**, with
optional public exposure via **Tailscale Funnel**. Everything persists to SQLite.
Zero runtime dependencies — it runs on Node.js built-ins only.

- **Webhooks** — give any provider a unique URL, capture every request with full
  history, inspect headers/body/query, verify HMAC signatures, enforce auth and
  rate limits, forward to your local server, replay payloads, and diff two requests.
- **Mock servers** — simulate a third-party API: a method + path, response
  scenarios (single or sequential), matching rules that override the response per
  request, artificial delays, auth, and rate limits.
- **Workspaces & projects** — organize endpoints into workspaces (e.g. per client or
  environment) and, within a workspace, group them into projects.
- **Tailscale Funnel** — expose the ingest port to the public internet with one
  click, driven by the real `tailscale` CLI.
- **Dashboard** — live counts, a combined activity feed across every webhook and
  mock, and a traffic overview (volume trend + status-code breakdown) for the
  active workspace.

## Requirements

- **Node.js ≥ 24** (uses the built-in `node:sqlite` — no native build step, no
  `npm install` required; `dependencies` is intentionally empty).
- **Tailscale** (optional) — only needed if you want to expose an endpoint publicly.
  Sidedoor shells out to the `tailscale` CLI; without it, everything works locally,
  the Funnel screen just shows it isn't available.

## Quick start

```bash
npm start                 # admin UI on http://localhost:4600
```

Open <http://localhost:4600>, create a webhook or mock, and start sending it
requests. To explore with demo data first:

```bash
npm run seed              # load demo workspaces, endpoints and captured requests
npm run reset              # wipe and reseed from scratch
npm run dev                 # like `start`, but restarts on file changes
```

## Core concepts

```
Workspace
 └─ Project (optional grouping)
     └─ Endpoint — a Webhook or a Mock server, addressed by a unique slug
         └─ Request — every call the endpoint received, captured with its response
```

- **Workspace** — the top-level container. Everything (endpoints, requests, funnel
  state) is scoped to the active workspace, switchable from the sidebar. You always
  have at least one; deleting the active workspace re-points you to another, and the
  last remaining workspace can't be deleted.
- **Project** — an optional folder within a workspace, used purely to group
  endpoints in the Webhooks/Mocks lists. Renaming or deleting a project never
  touches its endpoints — they just become ungrouped ("No project").
- **Endpoint** — either a **webhook** (an inspector: capture and show me everything
  sent to this URL) or a **mock** (respond to this exact method + path with a
  configured scenario). Both get edit and delete affordances from their card's
  overflow menu.
- **Request** — every call captured against an endpoint: method, path, headers,
  query, body, the response that was sent back, and an outcome
  (`captured` / `forwarded` / `dropped` / `responded` / `mock` / `rate_limited` /
  `unauthorized` / `unmatched`).

## Two servers, one database

Sidedoor runs **two HTTP listeners** on purpose:

| Server | Bind | Purpose |
| --- | --- | --- |
| **Admin** | `127.0.0.1:4600` | The UI + REST API. Localhost-only — never funnelled. |
| **Ingest** | `0.0.0.0:4601` | The webhook/mock runtime. The only surface Tailscale Funnel exposes. |

This split means enabling Funnel exposes your endpoints to the internet **without**
ever exposing the admin API. An endpoint is addressed by its globally-unique slug:

```
http://localhost:4601/<slug>                 # local
https://<machine>.<tailnet>.ts.net/<slug>    # public, when Funnel is on
```

## Using webhooks

Create one from **Webhooks → New webhook**: give it a name (the slug is derived
automatically, editable before creation), optionally assign it to a project, and
optionally turn on **signature validation** with a provider preset.

Every incoming request runs through this pipeline, in order:

1. **Auth** (if enabled) — Bearer token, API key (header or query), or Basic auth.
   A missing/wrong credential gets the configured failure status (default `401`)
   and is captured with outcome `unauthorized`.
2. **HMAC signature** (if enabled) — recomputed and compared with a timing-safe
   check. Presets: **Stripe**, **GitHub**, **Shopify**, **Twilio**, **Slack**, or a
   fully custom header/algorithm/encoding. Result is recorded as
   `valid` / `invalid` / `skipped`; you can choose whether an invalid signature is
   rejected (`401`) or just flagged for inspection.
3. **Rate limiting** (if enabled) — a token-bucket limiter keyed by client IP,
   endpoint, or a request header, with a configurable window (per second / minute /
   hour) and burst size. Exceeding it returns the configured status (default `429`)
   with an optional `Retry-After` header.
4. **Forwarding rules** — an ordered list of conditions (on a header, body field,
   query param, method, or path) that can **forward** the request to a local target,
   **drop** it (200, no forward), **respond** immediately with a custom
   status/body, **tag** it for easier searching, or **transform** the body before
   forwarding. Rules can require *all* or *any* condition to match. With no
   matching rule, the request is simply captured (like webhook.site).

From the request list you can **search and filter by method**, open any request to
see its **body / headers / query** in full, **replay** it (server-side, to any
target URL), select two requests to **diff** their bodies, and **export** a single
request or the entire endpoint's history as JSON.

## Using mock servers

Create one from **Mock Servers → New mock**: a method, a path, a default response
(status, content type, body, delay), and optionally auth.

- **A mock only ever responds to the method and path it was created for.** A
  different method gets `405` with an `Allow` header; a path other than the bare
  slug or slug + configured path gets `404`. This keeps a mock honest about what it
  simulates instead of silently answering anything sent to its URL.
- **Scenarios** — a mock can have several named responses (status, headers,
  content type, body, artificial delay). Add, edit, or delete them from the
  endpoint's Configuration tab; exactly one is ever "active" at a time (you can't
  delete the last remaining scenario).
- **Response mode** — **Single**: always the active scenario. **Sequential**: each
  request rotates to the next scenario in order, useful for simulating a flaky or
  changing API.
- **Matching rules** — override the active scenario for requests matching a
  condition (header / body field / query param / method / path, with `equals`,
  `contains`, `regex`, `exists`, `>`, `<`, or `≠`), evaluated top-to-bottom; the
  first match wins. Rules can be individually enabled/disabled and reordered.
  Disabled rules are skipped entirely.
- **Auth & rate limiting** work exactly as described for webhooks, above.

The endpoint's **Requests** tab shows every call it received, each with the request
and the exact response that was returned.

## Dashboard

The Overview screen shows, for the active workspace: endpoint counts, total
requests received (webhooks and mocks combined), Funnel status, a warning if a
publicly-exposed webhook has no signature validation, a combined **Recent
activity** feed (webhook and mock traffic side by side, each tagged with its
type), and a **Traffic overview** card — total volume and trend over 24h / 7d /
30d, a sparkline, and a 2xx/4xx/5xx breakdown.

## Tailscale Funnel

If the `tailscale` CLI is installed and logged in, the Funnel screen shows real
status and lets you toggle exposure. Enabling runs `tailscale funnel --bg <ingest
port>`; disabling runs a **targeted** `tailscale funnel <port> off` (it never runs a
global `funnel reset`, so other funnels you run outside Sidedoor are left alone).
Every toggle is recorded in a short exposure history. Secrets and config live in
the local SQLite file — treat that file as sensitive.

## HTTP methods

`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, and `QUERY` are supported
everywhere a method is configured, filtered, or displayed — including as a mock's
required method and as a webhook inspector filter.

## Configuration (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `SIDEDOOR_PORT` | `4600` | Admin UI + API port |
| `SIDEDOOR_HOST` | `127.0.0.1` | Admin bind host |
| `SIDEDOOR_INGEST_PORT` | `4601` | Ingest port (funnel-exposed) |
| `SIDEDOOR_INGEST_HOST` | `0.0.0.0` | Ingest bind host |
| `SIDEDOOR_DB` | `./sidedoor.db` | SQLite file path (`:memory:` for ephemeral) |
| `SIDEDOOR_MAX_BODY` | `5242880` | Max captured request body size, in bytes (larger → `413`) |
| `SIDEDOOR_TAILSCALE_BIN` | `tailscale` | Path to the tailscale CLI |
| `SIDEDOOR_FUNNEL_POLL_MS` | `10000` | Background funnel-status poll interval (`0` disables) |

## Admin API

All admin routes are under `http://localhost:4600/__sd/api` (localhost-only). A
representative sample — the UI is a plain client of this same API:

| Method & path | Purpose |
| --- | --- |
| `GET /state` | Bootstrap: workspaces, active workspace, counts, funnel summary |
| `GET/POST /workspaces`, `PATCH/DELETE /workspaces/:id` | Workspace CRUD |
| `GET /workspaces/:id/projects`, `POST /projects`, `PATCH/DELETE /projects/:id` | Project CRUD |
| `GET /endpoints`, `POST /endpoints`, `GET/PATCH/DELETE /endpoints/:id` | Endpoint (webhook/mock) CRUD |
| `POST /endpoints/:id/scenarios`, `PATCH/DELETE /scenarios/:id`, `POST /scenarios/:id/activate` | Mock scenarios |
| `POST /endpoints/:id/match-rules`, `PATCH/DELETE /match-rules/:id`, `POST /match-rules/:id/move` | Mock matching rules |
| `GET /endpoints/:id/requests`, `GET/DELETE /requests/:id`, `DELETE /endpoints/:id/requests` | Captured requests |
| `POST /requests/:id/replay`, `GET /requests/diff`, `GET /requests/:id/export` | Replay, diff, export |
| `GET /activity`, `GET /requests/overview` | Dashboard activity feed and traffic overview |
| `GET/POST /funnel`, `POST /funnel/enable\|disable\|refresh`, `GET /funnel/history` | Tailscale Funnel |
| `GET /events` | Server-Sent Events stream (live captured requests, funnel changes) |

The ingest server (port `4601`) has no admin routes — every path on it is resolved
to an endpoint by slug.

## Testing

```bash
npm test
```

The suite (`node:test`, zero-dep) covers the core libraries (HMAC per provider,
auth, token-bucket rate limiting, rule/field matching, LCS diff, validation), the
storage layer (CRUD, cascade deletes, unique slugs, migrations), the full REST API,
and every ingest pipeline branch — booting real servers on ephemeral ports and
driving them over HTTP.

## Project layout

```
src/
  server.js            entry — boots admin + ingest servers
  config.js  db.js  schema.sql  store.js  events.js  seed.js
  lib/       hmac, auth, ratelimit, match, diff, validate, tailscale, ids, json, colors
  api/       router.js  routes.js        (admin REST + SSE)
  ingest/    handler.js webhook.js mock.js
public/
  index.html app.js ui.js api.js styles.css sd-json-editor.js  screens/*
test/        *.test.js  helpers.js
```

The UI is a dependency-free vanilla-JS SPA; state-based routing keeps app routes
from ever colliding with ingest slugs, and the URL hash reflects your exact
position (endpoint, tab, open request) so a page reload returns you to where you
were.

## Security notes

- The admin server binds to `127.0.0.1` only and is never reachable through
  Funnel — only the ingest port is ever publicly exposed.
- Auth, HMAC, and rate-limit checks fail closed: an unconfigured secret or
  credential never matches an empty/absent one.
- HMAC comparison is timing-safe (`crypto.timingSafeEqual`).
- All configuration, including secrets, is stored locally in the SQLite file
  (`SIDEDOOR_DB`, default `./sidedoor.db`) — treat it like any other file holding
  credentials.
