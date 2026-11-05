import test from "node:test";
import assert from "node:assert/strict";

test("inventory reservations are idempotent and require JSON", async () => {
  process.env.SERVICE_NAME = "inventory-api";
  delete process.env.DATABASE_URL;
  const { start } = await import("../src/server.js");
  const completed = new Map(), inFlight = new Map();
  const eventStore = { reserveInventory(idempotencyKey, input, createId) {
    if (completed.has(idempotencyKey)) {
      const reservation = completed.get(idempotencyKey);
      if (reservation.sku !== input.sku || reservation.quantity !== input.quantity) {
        throw Object.assign(new Error("idempotency key was already used for another reservation"), { statusCode: 409 });
      }
      return { reservationId: reservation.id, created: false };
    }
    if (inFlight.has(idempotencyKey)) return inFlight.get(idempotencyKey);
    const creation = Promise.resolve().then(() => {
      const reservation = { id: createId(), ...input };
      completed.set(idempotencyKey, reservation);
      return { reservationId: reservation.id, created: true };
    }).finally(() => inFlight.delete(idempotencyKey));
    inFlight.set(idempotencyKey, creation);
    return creation;
  } };
  const server = await start(0, { eventStore });
  const url = `http://127.0.0.1:${server.address().port}/reserve`;

  for (const contentType of [undefined, "text/plain"]) {
    const headers = contentType ? { "content-type": contentType } : {};
    const response = await fetch(url, {
      method: "POST", headers, body: JSON.stringify({ sku: "demo", quantity: 1 }),
    });
    assert.equal(response.status, 415);
  }

  for (const input of [null, { sku: " ", quantity: 1 }, { sku: "demo", quantity: 0 }]) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 400);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "Application/JSON; charset=utf-8", "idempotency-key": "reservation-1" },
    body: JSON.stringify({ sku: "x".repeat(64), quantity: 100 }),
  });
  assert.equal(response.status, 200);
  const reservationId = (await response.json()).reservationId;
  assert.ok(reservationId);

  const reserve = (key, input = { sku: "demo", quantity: 1 }) => fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(input),
  });
  assert.equal((await reserve("", { sku: "demo", quantity: 1 })).status, 400);
  const missing = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sku: "demo", quantity: 1 }),
  });
  assert.equal(missing.status, 400);

  const [concurrentA, concurrentB] = await Promise.all([
    reserve("concurrent"), reserve("concurrent"),
  ]);
  assert.equal(concurrentA.status, 200);
  assert.equal(concurrentB.status, 200);
  assert.equal(
    (await concurrentA.json()).reservationId,
    (await concurrentB.json()).reservationId,
  );
  assert.equal((await reserve("concurrent", { sku: "other", quantity: 1 })).status, 409);
  const distinct = await reserve("distinct");
  assert.equal(distinct.status, 200);
  assert.notEqual((await distinct.json()).reservationId, reservationId);
  assert.equal(completed.size, 3);
  await new Promise((resolve) => server.close(resolve));
});
