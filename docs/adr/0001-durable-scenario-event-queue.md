# ADR 0001: Persist scenario-event delivery work in SQLite

## Context

Mock scenarios can return a response immediately and then make ordered, delayed
outbound callbacks. A process-local timer queue would lose pending work on restart,
would make delivery history incomplete, and could not support cancellation or live
delivery status reliably.

## Decision

Store scenario-event configuration separately from execution state in SQLite.
Creating a run snapshots the enabled event configuration and request/response
context into `event_runs`, then creates serial `event_jobs` and safe
`event_attempts`. A single persistent dispatcher claims due jobs, performs the
outbound request, records its result, and schedules retries or the next job.

On startup, jobs left running are returned to pending work. The resulting guarantee
is at-least-once: an interruption after a request reaches its destination but before
its result is persisted can lead to a repeated callback. The alternative, claiming
exactly-once delivery, would require cooperation and idempotency support from every
receiver and is not realistic for generic webhooks.

## Consequences

- Pending work and delivery history survive restart and support cancellation.
- Changes to a scenario event do not affect existing runs because each run has an
  immutable snapshot.
- The dispatcher is deliberately serial, preserving configured event/repeat order
  and keeping its failure behavior straightforward.
- Callers that need duplicate protection should use an idempotency key in their
  configured payload or headers.

## Alternatives considered

- **In-memory timers:** simpler but lose work/history on restart and cannot satisfy
  durable test or cancellation behavior.
- **A new external queue service:** offers horizontal scale but adds a deployment
  dependency to a local-first, zero-runtime-dependency application.
- **Exactly-once delivery:** cannot be guaranteed across an arbitrary HTTP boundary.
