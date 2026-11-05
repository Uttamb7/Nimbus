import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

test("order acceptance persists its outbox event before responding", async (t) => {
  t.mock.method(console, "log", () => {});
  let inventoryRequests = 0;
  const inventoryKeys = [];
  let failNextReservation = false;
  const inventory = createServer((request, response) => {
    inventoryRequests++;
    inventoryKeys.push(request.headers["idempotency-key"]);
    if (failNextReservation) {
      failNextReservation = false;
      response.writeHead(503, { "content-type": "application/json" });
      return response.end('{"error":"unavailable"}');
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"reservationId":"713615df-5085-4aec-8f45-79580c66b63d"}');
  });
  await new Promise((resolve) => inventory.listen(0, resolve));
  process.env.SERVICE_NAME = "order-orchestrator";
  process.env.INVENTORY_URL = `http://127.0.0.1:${inventory.address().port}`;
  delete process.env.DATABASE_URL;
  delete process.env.TELEMETRY_URL;
  const persisted = [];
  const completed = new Map(), inFlight = new Map();
  const eventStore = { createOrder(idempotencyKey, createEvent) {
    if (completed.has(idempotencyKey)) return { orderId: completed.get(idempotencyKey), created: false };
    if (inFlight.has(idempotencyKey)) return inFlight.get(idempotencyKey);
    const creation = (async () => {
      const event = await createEvent();
      persisted.push(event);
      completed.set(idempotencyKey, event.orderId);
      return { orderId: event.orderId, created: true };
    })().finally(() => inFlight.delete(idempotencyKey));
    inFlight.set(idempotencyKey, creation);
    return creation;
  } };
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

  for (const headers of [
    { "x-correlation-id": "contains space", "idempotency-key": "checkout-1" },
    { "x-correlation-id": "correlation-1", "idempotency-key": "x".repeat(129) },
  ]) {
    const rejected = await fetch(`http://127.0.0.1:${server.address().port}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ sku: "demo", quantity: 1 }),
    });
    assert.equal(rejected.status, 400);
  }
  assert.equal(inventoryRequests, 0);
  assert.equal(persisted.length, 0);

  for (const input of [[], { sku: "", quantity: 1 }, { sku: "demo", quantity: 101 }]) {
    const rejected = await fetch(`http://127.0.0.1:${server.address().port}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "checkout-1" },
      body: JSON.stringify(input),
    });
    assert.equal(rejected.status, 400);
  }
  assert.equal(inventoryRequests, 0);
  assert.equal(persisted.length, 0);

  const response = await fetch(`http://127.0.0.1:${server.address().port}/orders`, {
    method: "POST",
    headers: { "content-type": "Application/JSON; charset=utf-8", "idempotency-key": "i".repeat(128), "x-correlation-id": "c".repeat(128) },
    body: JSON.stringify({ sku: "x".repeat(64), quantity: 100 }),
  });

  assert.equal(response.status, 202);
  const order = await response.json();
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].orderId, order.orderId);
  assert.equal(persisted[0].correlationId, "c".repeat(128));
  assert.equal(persisted[0].idempotencyKey, "i".repeat(128));
  assert.equal(persisted[0].type, "order.created");
  assert.equal(inventoryRequests, 1);

  const generated = await fetch(`http://127.0.0.1:${server.address().port}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sku: "demo", quantity: 1 }),
  });
  assert.equal(generated.status, 202);
  assert.match(persisted[1].correlationId, /^[0-9a-f-]{36}$/);
  assert.match(persisted[1].idempotencyKey, /^[0-9a-f-]{36}$/);

  const postOrder = (idempotencyKey) => fetch(`http://127.0.0.1:${server.address().port}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({ sku: "demo", quantity: 1 }),
  });
  const inventoryBeforeReplay = inventoryRequests;
  const replay = await postOrder("i".repeat(128));
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).orderId, order.orderId);
  assert.equal(inventoryRequests, inventoryBeforeReplay);
  assert.equal(persisted.length, 2);

  const [concurrentA, concurrentB] = await Promise.all([
    postOrder("concurrent-order"), postOrder("concurrent-order"),
  ]);
  assert.equal(concurrentA.status, 202);
  assert.equal(concurrentB.status, 202);
  assert.equal((await concurrentA.json()).orderId, (await concurrentB.json()).orderId);
  assert.equal(inventoryRequests, inventoryBeforeReplay + 1);
  assert.equal(persisted.length, 3);

  failNextReservation = true;
  assert.equal((await postOrder("retry-after-failure")).status, 502);
  const retried = await postOrder("retry-after-failure");
  assert.equal(retried.status, 202);
  assert.ok((await retried.json()).orderId);
  assert.equal(inventoryRequests, inventoryBeforeReplay + 3);
  assert.equal(persisted.length, 4);
  assert.ok(inventoryKeys.every((key) => typeof key === "string" && key.length > 0));
  assert.ok(inventoryKeys.includes("concurrent-order"));
  assert.equal(inventoryKeys.filter((key) => key === "retry-after-failure").length, 2);
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => inventory.close(resolve));
});
