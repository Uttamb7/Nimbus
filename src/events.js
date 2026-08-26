import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

export function orderCreated({ correlationId, idempotencyKey, orderId, reservationId, traceContext }, now = () => new Date().toISOString(), uuid = randomUUID) {
  return { eventId: uuid(), correlationId, idempotencyKey, type: "order.created", version: 1, createdAt: now(), orderId, reservationId, ...(traceContext?.traceparent ? { traceContext } : {}) };
}

export class OutboxPublisher {
  constructor({ store, publishEvent, waitFor = wait, random = Math.random, maxAttempts = 10, maxDelayMs = 5_000 }) {
    this.store = store;
    this.publishEvent = publishEvent;
    this.waitFor = waitFor;
    this.random = random;
    this.maxAttempts = maxAttempts;
    this.maxDelayMs = maxDelayMs;
    this.running = false;
  }

  async runOnce() {
    const claimed = await this.store.claim();
    if (!claimed) return false;
    const { event, attemptCount } = claimed;
    try {
      await this.publishEvent(event);
      await this.store.markPublished(event.eventId);
    } catch (error) {
      if (attemptCount >= this.maxAttempts) await this.store.deadLetter(event.eventId, error.message);
      else {
        const exponential = Math.min(this.maxDelayMs / 2, 250 * 2 ** (attemptCount - 1));
        await this.store.retry(event.eventId, exponential + Math.floor(this.random() * exponential), error.message);
      }
    }
    return true;
  }

  start() {
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        try {
          if (!await this.runOnce()) await this.waitFor(100);
        } catch (error) {
          console.error(JSON.stringify({ type: "outbox-publisher-error", service: process.env.SERVICE_NAME, message: error.message }));
          await this.waitFor(500);
        }
      }
    })();
  }

  async stop() {
    this.running = false;
    await this.loop;
  }
}
