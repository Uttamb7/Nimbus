import test from "node:test";
import assert from "node:assert/strict";
import { deliver, orderCreated, OutboxPublisher } from "../src/events.js";

test("event delivery retries transient and permanent failures", async (t) => {
  let attempts = 0;
  let permanent = false;
  const failures = [];
  process.env.SERVICE_NAME = "order-orchestrator";
  delete process.env.TELEMETRY_URL;
  t.mock.method(globalThis, "fetch", async () => {
    attempts++;
    if (permanent || attempts < 3) throw new Error("offline");
    return new Response("{}", { status: 202 });
  });
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", (message) => failures.push(JSON.parse(message)));

  const event = { eventId: "event-1" };
  await deliver("http://payment-worker:8080/events", event, "correlation-1");
  assert.equal(attempts, 3);
  assert.equal(failures.length, 0);

  attempts = 0;
  permanent = true;
  await assert.rejects(deliver("http://payment-worker:8080/events", event, "correlation-1"), /offline/);
  assert.equal(attempts, 3);
  assert.deepEqual(failures[0], {
    type: "event-delivery-failed",
    service: "order-orchestrator",
    target: "http://payment-worker:8080/events",
    event_id: "event-1",
    correlation_id: "correlation-1",
    attempts: 3,
    message: "offline",
  });
});

test("order event envelope carries durable delivery identifiers", () => {
  const event = orderCreated(
    { correlationId: "correlation-1", idempotencyKey: "checkout-1", orderId: "order-1", reservationId: "reservation-1" },
    () => "2026-08-20T12:00:00.000Z",
    () => "event-1",
  );
  assert.deepEqual(event, {
    eventId: "event-1",
    correlationId: "correlation-1",
    idempotencyKey: "checkout-1",
    type: "order.created",
    version: 1,
    createdAt: "2026-08-20T12:00:00.000Z",
    orderId: "order-1",
    reservationId: "reservation-1",
  });
});

test("outbox publisher records retry state and publishes only after every target acknowledges", async () => {
  const event = { eventId: "event-1", correlationId: "correlation-1" };
  const claimed = [{ event, attemptCount: 1 }, { event, attemptCount: 2 }, { event, attemptCount: 5 }];
  const calls = [];
  const store = {
    claim: async () => claimed.shift() || null,
    markPublished: async (id) => calls.push(["published", id]),
    retry: async (...args) => calls.push(["retry", ...args]),
    deadLetter: async (...args) => calls.push(["dead", ...args]),
  };
  let fail = true;
  const publisher = new OutboxPublisher({
    store,
    targets: ["payment", "analytics"],
    random: () => 0.5,
    deliverEvent: async (target) => {
      calls.push(["deliver", target]);
      if (fail && target === "analytics") throw new Error("offline");
    },
  });

  await publisher.runOnce();
  assert.deepEqual(calls.at(-1), ["retry", "event-1", 375, "offline"]);
  fail = false;
  await publisher.runOnce();
  assert.deepEqual(calls.at(-1), ["published", "event-1"]);
  fail = true;
  await publisher.runOnce();
  assert.deepEqual(calls.at(-1), ["dead", "event-1", "offline"]);
});
