import test from "node:test";
import assert from "node:assert/strict";
import { orderCreated, OutboxPublisher } from "../src/events.js";

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

test("outbox publisher records retry state and publishes only after broker confirmation", async () => {
  const event = { eventId: "event-1", correlationId: "correlation-1" };
  const claimed = [{ event, attemptCount: 1 }, { event, attemptCount: 2 }, { event, attemptCount: 10 }];
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
    random: () => 0.5,
    publishEvent: async () => {
      calls.push(["publish"]);
      if (fail) throw new Error("offline");
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
