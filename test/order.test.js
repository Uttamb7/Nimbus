import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

test("order acceptance persists its outbox event before responding", async (t) => {
  t.mock.method(console, "log", () => {});
  let inventoryRequests = 0;
  const inventory = createServer((request, response) => {
    inventoryRequests++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"reservationId":"713615df-5085-4aec-8f45-79580c66b63d"}');
  });
  await new Promise((resolve) => inventory.listen(0, resolve));
  process.env.SERVICE_NAME = "order-orchestrator";
  process.env.INVENTORY_URL = `http://127.0.0.1:${inventory.address().port}`;
  delete process.env.DATABASE_URL;
  delete process.env.TELEMETRY_URL;
  const persisted = [];
  const eventStore = { createOrder: async (event) => persisted.push(event) };
  const publisher = { start() {}, async stop() {} };
  const { start } = await import("../src/server.js");
  const server = await start(0, { eventStore, publisher });

  for (const contentType of [undefined, "text/plain"]) {
    const headers = { "idempotency-key": "checkout-1" };
    if (contentType) headers["content-type"] = contentType;
    const rejected = await fetch(`http://127.0.0.1:${server.address().port}/orders`, {
      method: "POST", headers, body: JSON.stringify({ sku: "demo", quantity: 1 }),
    });
    assert.equal(rejected.status, 415);
  }
  assert.equal(inventoryRequests, 0);
  assert.equal(persisted.length, 0);

  const response = await fetch(`http://127.0.0.1:${server.address().port}/orders`, {
    method: "POST",
    headers: { "content-type": "Application/JSON; charset=utf-8", "idempotency-key": "checkout-1", "x-correlation-id": "correlation-1" },
    body: JSON.stringify({ sku: "demo", quantity: 1 }),
  });

  assert.equal(response.status, 202);
  const order = await response.json();
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].orderId, order.orderId);
  assert.equal(persisted[0].correlationId, "correlation-1");
  assert.equal(persisted[0].idempotencyKey, "checkout-1");
  assert.equal(persisted[0].type, "order.created");
  assert.equal(inventoryRequests, 1);
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => inventory.close(resolve));
});
