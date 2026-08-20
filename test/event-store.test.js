import test from "node:test";
import assert from "node:assert/strict";
import { EventStore } from "../src/event-store.js";

test("order and outbox event commit in one transaction", async () => {
  const queries = [];
  const client = {
    query: async (text, values) => queries.push({ text, values }),
    release: () => queries.push({ text: "RELEASE" }),
  };
  const store = new EventStore({ pool: { connect: async () => client } });
  const event = {
    eventId: "b08a1c40-1f55-4fc9-b0cc-d170ac248476",
    orderId: "af0fb946-d2d2-4a49-a9d4-c2e2096ba695",
    reservationId: "713615df-5085-4aec-8f45-79580c66b63d",
    idempotencyKey: "checkout-1",
    createdAt: "2026-08-20T12:00:00.000Z",
  };

  await store.createOrder(event);

  assert.deepEqual(queries.map(({ text }) => text.trim().split(" ")[0]), ["BEGIN", "INSERT", "INSERT", "COMMIT", "RELEASE"]);
  assert.deepEqual(queries[1].values, [event.orderId, event.reservationId, event.idempotencyKey, event.createdAt]);
  assert.deepEqual(queries[2].values, [event.eventId, event.orderId, JSON.stringify(event), event.createdAt]);
});

test("failed outbox write rolls back the order transaction", async () => {
  const queries = [];
  const client = {
    query: async (text) => {
      queries.push(text);
      if (text.includes("INSERT INTO outbox_events")) throw new Error("outbox unavailable");
    },
    release: () => queries.push("RELEASE"),
  };
  const store = new EventStore({ pool: { connect: async () => client } });

  await assert.rejects(store.createOrder({ orderId: "order", reservationId: "reservation", idempotencyKey: "key", eventId: "event", createdAt: "now" }), /outbox unavailable/);
  assert.equal(queries.at(-2), "ROLLBACK");
  assert.equal(queries.at(-1), "RELEASE");
});

test("outbox claim returns the persisted attempt count", async () => {
  let query;
  const pool = { query: async (text) => {
    query = text;
    return { rows: [{ event: { eventId: "event-1" }, attempt_count: 3 }] };
  } };
  const store = new EventStore({ pool });
  assert.deepEqual(await store.claim(), { event: { eventId: "event-1" }, attemptCount: 3 });
  assert.match(query, /FOR UPDATE SKIP LOCKED/);
  assert.match(query, /claimed_at < now\(\) - interval '30 seconds'/);
});
