import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

test("checkout requires JSON before calling dependencies", async (t) => {
  t.mock.method(console, "log", () => {});
  const calls = [];
  let rejectIdentity = false;
  const dependency = createServer((request, response) => {
    calls.push(request.url);
    if (request.url === "/users/me" && rejectIdentity) {
      response.writeHead(503, { "content-type": "application/json" });
      return response.end('{"error":"unavailable"}');
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.url === "/users/me"
      ? '{"id":"demo-user"}'
      : '{"orderId":"order-1","status":"accepted"}');
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
  calls.length = 0;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "Application/JSON; charset=utf-8" },
    body: JSON.stringify({ sku: "x".repeat(64), quantity: 100 }),
  });
  assert.equal(response.status, 202);
  assert.deepEqual(calls, ["/users/me", "/orders"]);

  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => dependency.close(resolve));
});
