import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

test("checkout requires JSON before calling dependencies", async (t) => {
  t.mock.method(console, "log", () => {});
  const calls = [];
  const dependency = createServer((request, response) => {
    calls.push(request.url);
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

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "Application/JSON; charset=utf-8" },
    body: JSON.stringify({ sku: "demo", quantity: 1 }),
  });
  assert.equal(response.status, 202);
  assert.deepEqual(calls.sort(), ["/orders", "/users/me"]);

  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => dependency.close(resolve));
});
