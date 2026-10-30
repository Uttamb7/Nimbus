import test from "node:test";
import assert from "node:assert/strict";

test("inventory reservations require JSON", async () => {
  process.env.SERVICE_NAME = "inventory-api";
  const { start } = await import("../src/server.js");
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/reserve`;

  for (const contentType of [undefined, "text/plain"]) {
    const headers = contentType ? { "content-type": contentType } : {};
    const response = await fetch(url, {
      method: "POST", headers, body: JSON.stringify({ sku: "demo", quantity: 1 }),
    });
    assert.equal(response.status, 415);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "Application/JSON; charset=utf-8" },
    body: JSON.stringify({ sku: "demo", quantity: 1 }),
  });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).reservationId);
  await new Promise((resolve) => server.close(resolve));
});
