import test from "node:test";
import assert from "node:assert/strict";
import { EventStore } from "../src/event-store.js";

test("order and outbox event commit in one transaction", async () => {
  const queries = [];
  const client = {
    query: async (text, values) => {
      queries.push({ text, values });
      return { rows: [] };
    },
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

  const result = await store.createOrder(event.idempotencyKey, async () => event);

  assert.deepEqual(result, { orderId: event.orderId, created: true });
  assert.deepEqual(queries.map(({ text }) => text.trim().split(" ")[0]), ["BEGIN", "SELECT", "SELECT", "INSERT", "INSERT", "COMMIT", "RELEASE"]);
  assert.match(queries[1].text, /hashtextextended\(\$1, 0\)/);
  assert.deepEqual(queries[1].values, [event.idempotencyKey]);
  assert.deepEqual(queries[3].values, [event.orderId, event.reservationId, event.idempotencyKey, event.createdAt]);
  assert.deepEqual(queries[4].values, [event.eventId, event.orderId, JSON.stringify(event), event.createdAt]);
});

test("completed idempotency key replays without creating another event", async () => {
  const queries = [];
  const client = {
    query: async (text, values) => {
      queries.push({ text, values });
      return text.includes("SELECT id FROM orders")
        ? { rows: [{ id: "af0fb946-d2d2-4a49-a9d4-c2e2096ba695" }] }
        : { rows: [] };
    },
    release: () => queries.push({ text: "RELEASE" }),
  };
  const store = new EventStore({ pool: { connect: async () => client } });

  const result = await store.createOrder("checkout-1", async () => assert.fail("created duplicate"));

  assert.deepEqual(result, { orderId: "af0fb946-d2d2-4a49-a9d4-c2e2096ba695", created: false });
  assert.deepEqual(queries.map(({ text }) => text.trim().split(" ")[0]), ["BEGIN", "SELECT", "SELECT", "COMMIT", "RELEASE"]);
});

test("failed outbox write rolls back the order transaction", async () => {
  const queries = [];
  const client = {
    query: async (text) => {
      queries.push(text);
      if (text.includes("INSERT INTO outbox_events")) throw new Error("outbox unavailable");
      return { rows: [] };
    },
    release: () => queries.push("RELEASE"),
  };
  const store = new EventStore({ pool: { connect: async () => client } });

  await assert.rejects(store.createOrder("key", async () => ({ orderId: "order", reservationId: "reservation", idempotencyKey: "key", eventId: "event", createdAt: "now" })), /outbox unavailable/);
  assert.equal(queries.at(-2), "ROLLBACK");
  assert.equal(queries.at(-1), "RELEASE");
});

test("inventory reservations replay identical requests and reject conflicts", async () => {
  const rows = [];
  const queries = [];
  const client = {
    query: async (text, values) => {
      queries.push({ text, values });
      if (text.includes("SELECT id, sku, quantity")) return { rows };
      return { rows: [] };
    },
    release: () => queries.push({ text: "RELEASE" }),
  };
  const store = new EventStore({ pool: { connect: async () => client } });

  const created = await store.reserveInventory(
    "checkout-1", { sku: "demo", quantity: 2 },
    () => "713615df-5085-4aec-8f45-79580c66b63d",
  );
  assert.deepEqual(created, {
    reservationId: "713615df-5085-4aec-8f45-79580c66b63d", created: true,
  });
  assert.match(queries[1].text, /hashtextextended\(\$1, 1\)/);
  assert.deepEqual(queries[3].values, [
    created.reservationId, "checkout-1", "demo", 2,
  ]);

  rows.push({ id: created.reservationId, sku: "demo", quantity: 2 });
  assert.deepEqual(
    await store.reserveInventory("checkout-1", { sku: "demo", quantity: 2 }, assert.fail),
    { reservationId: created.reservationId, created: false },
  );
  await assert.rejects(
    store.reserveInventory("checkout-1", { sku: "other", quantity: 2 }, assert.fail),
    (error) => error.statusCode === 409,
  );
  assert.equal(queries.at(-2).text, "ROLLBACK");
  assert.equal(queries.at(-1).text, "RELEASE");
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

test("consumer receipt insert identifies duplicate delivery", async () => {
  const queries = [];
  const pool = { query: async (text, values) => {
    queries.push({ text, values });
    return { rowCount: queries.length === 1 ? 1 : 0 };
  } };
  const store = new EventStore({ pool });

  assert.equal(await store.recordConsumerEvent("payment-worker", "b08a1c40-1f55-4fc9-b0cc-d170ac248476"), true);
  assert.equal(await store.recordConsumerEvent("payment-worker", "b08a1c40-1f55-4fc9-b0cc-d170ac248476"), false);
  assert.match(queries[0].text, /ON CONFLICT DO NOTHING/);
  assert.deepEqual(queries[0].values, ["payment-worker", "b08a1c40-1f55-4fc9-b0cc-d170ac248476"]);
});
