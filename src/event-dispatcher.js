// Persistent, single-worker dispatcher for asynchronous scenario events.
// Serial execution is intentional: it makes each run's ordering explicit and
// keeps the at-least-once recovery boundary small and auditable.
import { sendOutboundEvent } from './lib/outbound.js';

export class EventDispatcher {
  constructor({ store, events, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    this.store = store;
    this.events = events;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.started = false;
    this.stopped = false;
    this.timer = null;
    this.processing = false;
    this.processingPromise = null;
    this.activeController = null;
    this.activeRunId = null;
  }

  start() {
    if (this.started) return 0;
    this.started = true;
    this.stopped = false;
    const recovered = this.store.recoverEventJobs(this.now());
    this.wake();
    return recovered;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.activeController) this.activeController.abort();
    if (this.processingPromise) await this.processingPromise;
    this.started = false;
  }

  cancelRun(runId) {
    if (this.activeRunId === runId && this.activeController) this.activeController.abort();
    this.wake();
  }

  wake() {
    if (!this.started || this.stopped || this.processing) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const dueAt = this.store.nextEventJobAt();
    if (dueAt == null) return;
    const wait = Math.max(0, dueAt - this.now());
    if (wait === 0) {
      this.processing = true;
      this.processingPromise = Promise.resolve().then(() => this.drain()).finally(() => {
        this.processing = false;
        this.processingPromise = null;
        if (!this.stopped) this.wake();
      });
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wake();
    }, wait);
    if (this.timer.unref) this.timer.unref();
  }

  async drain() {
    while (!this.stopped) {
      const execution = this.store.claimDueEventJob(this.now());
      if (!execution) return;
      const controller = new AbortController();
      this.activeController = controller;
      this.activeRunId = execution.run.id;
      const startedAt = this.now();
      let outcome;
      try {
        outcome = await sendOutboundEvent(execution.event, execution.run.context, {
          fetchImpl: this.fetchImpl,
          signal: controller.signal,
          now: this.now,
        });
      } catch (error) {
        // sendOutboundEvent normally converts all operational failures to an
        // outcome. This final guard protects the queue if a custom fetch stub
        // or an unexpected runtime error escapes it.
        outcome = { ok: false, retryable: true, kind: 'network', error: String(error && error.message || error), durationMs: this.now() - startedAt };
      } finally {
        this.activeController = null;
        this.activeRunId = null;
      }

      // Leave the claimed job as "running" during shutdown. On the next boot
      // recovery requeues it, which is the deliberate at-least-once boundary.
      if (this.stopped) return;
      const finishedAt = this.now();
      const run = this.store.recordEventAttempt(execution.job.id, { ...outcome, startedAt, finishedAt }, finishedAt);
      if (run && this.events) {
        this.events.broadcast('delivery', { endpointId: execution.run.endpointId, run: this.store.getEventRun(run.id) });
      }
    }
  }
}
