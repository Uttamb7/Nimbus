import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { request } from "./http.js";

const retryDelays = [0, 100, 200];

export function orderCreated({ correlationId, idempotencyKey, orderId, reservationId }, now = () => new Date().toISOString(), uuid = randomUUID) {
  return { eventId: uuid(), correlationId, idempotencyKey, type: "order.created", version: 1, createdAt: now(), orderId, reservationId };
}

export async function deliver(target, event, correlationId) {
  let error;
  for (const delay of retryDelays) {
    if (delay) await wait(delay);
    try {
      return await request(target, { method: "POST", body: JSON.stringify(event) }, correlationId);
    } catch (caught) {
      error = caught;
    }
  }
  console.error(JSON.stringify({ type: "event-delivery-failed", service: process.env.SERVICE_NAME, target, event_id: event.eventId, correlation_id: correlationId, attempts: retryDelays.length, message: error.message }));
  throw error;
}

export class OutboxPublisher {
  constructor({ store, targets, deliverEvent = deliver, waitFor = wait, random = Math.random, maxAttempts = 5 }) {
    this.store = store;
    this.targets = targets;
    this.deliverEvent = deliverEvent;
    this.waitFor = waitFor;
    this.random = random;
    this.maxAttempts = maxAttempts;
    this.running = false;
  }

  async runOnce() {
    const claimed = await this.store.claim();
    if (!claimed) return false;
    const { event, attemptCount } = claimed;
    try {
      await Promise.all(this.targets.map((target) => this.deliverEvent(target, event, event.correlationId)));
      await this.store.markPublished(event.eventId);
    } catch (error) {
      if (attemptCount >= this.maxAttempts) await this.store.deadLetter(event.eventId, error.message);
      else {
        const exponential = 250 * 2 ** (attemptCount - 1);
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
