# ADR 0002: Multiplex realtime protocols on the ingest listener

## Context

Sidedoor previously accepted HTTP requests only. API integrations increasingly use
raw WebSocket conversations, Socket.IO, and GraphQL subscriptions, but the
administrative surface must remain localhost-only and existing HTTP mock/webhook
behavior must not change. The project also documented a zero-runtime-dependency
constraint that is incompatible with reliable protocol implementations.

## Decision

Keep the existing two-listener model. The ingest HTTP server continues to serve
HTTP endpoints and also owns protocol upgrades:

- raw WebSocket and `graphql-transport-ws` upgrade at `/<slug>`;
- Socket.IO owns `/_sidedoor/socket.io/` and resolves `/<slug>` as its namespace;
- the admin listener remains HTTP/SSE only and never accepts public protocol
  traffic.

Use mature protocol libraries: `ws`, `socket.io`, `graphql`, and `graphql-ws`.
Persist protocol-neutral sessions and safe message transcripts in SQLite, with
protocol-specific scripts for WebSocket/Socket.IO and SDL plus fixtures for
GraphQL. Open sessions are explicitly closed as `server_shutdown` during startup
or shutdown; they are not reconnectable or resumable.

## Consequences

- HTTP endpoints retain `protocol: http` and their existing routing semantics.
- Realtime mock behavior is durable and observable without storing unbounded or
  secret-bearing payloads.
- Socket.IO supports both polling and WebSocket transport while keeping a reserved
  path separate from normal endpoint slugs.
- The package now has runtime dependencies and requires `npm install`, trading a
  smaller install footprint for maintained protocol compliance and safer handling
  of upgrades, framing, GraphQL validation, and Socket.IO transport details.
- A public Funnel deployment needs an environment-specific WebSocket upgrade smoke
  test; local transport coverage alone cannot prove the external proxy path.

## Alternatives considered

- **Implement all protocols with Node built-ins:** raw upgrades are possible, but
  Socket.IO framing/polling and GraphQL WS protocol support would duplicate mature,
  security-sensitive implementations.
- **Run a separate realtime server:** adds ports and public-routing complexity and
  makes endpoint URLs harder to reason about.
- **Use an in-memory transcript/session registry:** loses diagnostic history on
  restart and cannot support durable administrative inspection or cleanup.
