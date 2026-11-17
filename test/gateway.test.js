import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

test("checkout requires JSON before calling dependencies", async (t) => {
  t.mock.method(console, "log", () => {});
  const calls = [];
  const identifiers = [];
  let rejectIdentity = false;
  let rejectOrder = false;
  let oversizedIdentity = false;
  let identityPayload = { id: "demo-user", active: true };
  let orderPayload = { orderId: "order-1", status: "accepted" };
  const dependency = createServer((request, response) => {
    calls.push(request.url);
    identifiers.push({ correlationId: request.headers["x-correlation-id"], idempotencyKey: request.headers["idempotency-key"] });
    if (request.url === "/users/me" && rejectIdentity) {
      response.writeHead(503, { "content-type": "application/json" });
      return response.end('{"error":"unavailable"}');
    }
    if (request.url === "/users/me" && oversizedIdentity) {
      const payload = JSON.stringify({ value: "x".repeat(64 * 1024) });
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      });
      return response.end(payload);
    }
    if (request.url === "/orders" && rejectOrder) {
      response.writeHead(409, { "content-type": "application/json" });
      return response.end('{"error":"conflicting idempotency key"}');
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/users/me" ? identityPayload : orderPayload));
  });
  await new Promise((resolve) => dependency.listen(0, resolve));
  process.env.SERVICE_NAME = "gateway";
  process.env.IDENTITY_URL = `http://127.0.0.1:${dependency.address().port}`;
  process.env.ORDER_URL = `http://127.0.0.1:${dependency.address().port}`;
  delete process.env.TELEMETRY_URL;
  const { start } = await import("../src/server.js");
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/checkout`;

  for (const contentType of [undefined, "text/plain"]) {
    const headers = contentType ? { "content-type": contentType } : {};
    const response = await fetch(url, {
      method: "POST", headers, body: JSON.stringify({ sku: "demo", quantity: 1 }),
    });
    assert.equal(response.status, 415);
  }
  assert.deepEqual(calls, []);

  const malformed = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" }, body: '{"sku":',
  });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /valid JSON/);
  assert.deepEqual(calls, []);

  for (const headers of [
    { "x-correlation-id": "contains space" },
    { "x-correlation-id": "x".repeat(129) },
    { "idempotency-key": "" },
    { "idempotency-key": "x".repeat(129) },
  ]) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ sku: "demo", quantity: 1 }),
    });
    assert.equal(response.status, 400);
    assert.notEqual((await response.json()).correlationId, headers["x-correlation-id"]);
  }
  assert.deepEqual(calls, []);

  for (const input of [null, [], {}, { sku: " ", quantity: 1 }, { sku: "x".repeat(65), quantity: 1 }, { sku: "demo", quantity: 0 }, { sku: "demo", quantity: 101 }, { sku: "demo", quantity: 1.5 }]) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 400);
  }
  assert.deepEqual(calls, []);

  rejectIdentity = true;
  const rejected = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sku: "demo", quantity: 1 }),
  });
  assert.equal(rejected.status, 502);
  assert.deepEqual(calls, ["/users/me"]);

  rejectIdentity = false;
  oversizedIdentity = true;
  calls.length = 0;
  const oversized = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sku: "demo", quantity: 1 }),
  });
  assert.equal(oversized.status, 502);
  assert.deepEqual(calls, ["/users/me"]);

  oversizedIdentity = false;
  for (const invalid of [[], { id: "demo-user" }, { id: "contains space", active: true }]) {
    identityPayload = invalid;
    calls.length = 0;
    const rejectedPayload = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: "demo", quantity: 1 }),
    });
    assert.equal(rejectedPayload.status, 502);
    assert.deepEqual(calls, ["/users/me"]);
  }

  identityPayload = { id: "u".repeat(128), active: true };
  for (const invalid of [{}, { orderId: "contains space", status: "accepted" }, { orderId: "order-1", status: "pending" }]) {
    orderPayload = invalid;
    calls.length = 0;
    const rejectedPayload = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: "demo", quantity: 1 }),
    });
    assert.equal(rejectedPayload.status, 502);
    assert.deepEqual(calls, ["/users/me", "/orders"]);
  }

  orderPayload = { orderId: "o".repeat(128), status: "accepted" };
  calls.length = 0;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "Application/JSON; charset=utf-8",
      "x-correlation-id": "c".repeat(128),
      "idempotency-key": "i".repeat(128),
    },
    body: JSON.stringify({ sku: "x".repeat(64), quantity: 100 }),
  });
  assert.equal(response.status, 202);
  assert.deepEqual(calls, ["/users/me", "/orders"]);
  assert.deepEqual(await response.json(), {
    userId: "u".repeat(128), orderId: "o".repeat(128), status: "accepted",
    correlationId: "c".repeat(128),
  });
  assert.deepEqual(identifiers.slice(-2), [
    { correlationId: "c".repeat(128), idempotencyKey: undefined },
    { correlationId: "c".repeat(128), idempotencyKey: "i".repeat(128) },
  ]);

  rejectOrder = true;
  const conflict = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "i".repeat(128) },
    body: JSON.stringify({ sku: "different", quantity: 100 }),
  });
  assert.equal(conflict.status, 409);
  rejectOrder = false;

  calls.length = 0;
  identifiers.length = 0;
  const generated = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sku: "demo", quantity: 1 }),
  });
  assert.equal(generated.status, 202);
  assert.match((await generated.json()).correlationId, /^[0-9a-f-]{36}$/);
  assert.match(identifiers[1].idempotencyKey, /^[0-9a-f-]{36}$/);

  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => dependency.close(resolve));
});
