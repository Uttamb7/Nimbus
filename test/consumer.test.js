import test from "node:test";
import assert from "node:assert/strict";

test("consumer records an event before suppressing its duplicate", async (t) => {
  process.env.SERVICE_NAME = "payment-worker";
  delete process.env.DATABASE_URL;
  delete process.env.TELEMETRY_URL;
  const logged = [];
  const receipts = [];
  t.mock.method(console, "log", (message) => logged.push(JSON.parse(message)));
  const eventStore = {
    recordConsumerEvent: async (consumer, eventId) => {
      receipts.push([consumer, eventId]);
      return receipts.length === 1;
    },
  };
  const { start } = await import("../src/server.js");
  const server = await start(0, { eventStore });
  const url = `http://127.0.0.1:${server.address().port}/events`;
  const event = {
    eventId: "b08a1c40-1f55-4fc9-b0cc-d170ac248476",
    correlationId: "correlation-1",
    idempotencyKey: "checkout-1",
    type: "order.created",
    version: 1,
    createdAt: "2026-11-11T12:00:00.000Z",
    orderId: "order-1",
    reservationId: "reservation-1",
  };

  for (const contentType of [undefined, "text/plain"]) {
    const headers = contentType ? { "content-type": contentType } : {};
    const rejected = await fetch(url, { method: "POST", headers, body: JSON.stringify(event) });
    assert.equal(rejected.status, 415);
  }
  assert.deepEqual(receipts, []);
  assert.deepEqual(logged, []);

  const headers = { "content-type": "Application/JSON; charset=utf-8" };
  for (const invalid of [null, [], { ...event, orderId: "" }, { ...event, traceContext: { traceparent: 7 } }]) {
    const rejected = await fetch(url, { method: "POST", headers, body: JSON.stringify(invalid) });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error, "invalid event envelope");
  }
  assert.deepEqual(receipts, []);
  assert.deepEqual(logged, []);

  const first = await fetch(url, { method: "POST", headers, body: JSON.stringify(event) });
  const duplicate = await fetch(url, { method: "POST", headers, body: JSON.stringify(event) });

  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { accepted: true });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { duplicate: true });
  assert.equal(logged.length, 1);
  assert.deepEqual(receipts, [["payment-worker", event.eventId], ["payment-worker", event.eventId]]);
  await new Promise((resolve) => server.close(resolve));
});
