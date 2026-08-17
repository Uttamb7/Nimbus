import test from "node:test";
import assert from "node:assert/strict";
import { deliver } from "../src/events.js";

test("event delivery retries transient and permanent failures", async (t) => {
  let attempts = 0;
  let permanent = false;
  const failures = [];
  process.env.SERVICE_NAME = "order-orchestrator";
  delete process.env.TELEMETRY_URL;
  t.mock.method(globalThis, "fetch", async () => {
    attempts++;
    if (permanent || attempts < 3) throw new Error("offline");
    return new Response("{}", { status: 202 });
  });
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", (message) => failures.push(JSON.parse(message)));

  const event = { eventId: "event-1" };
  await deliver("http://payment-worker:8080/events", event, "correlation-1");
  assert.equal(attempts, 3);
  assert.equal(failures.length, 0);

  attempts = 0;
  permanent = true;
  await deliver("http://payment-worker:8080/events", event, "correlation-1");
  assert.equal(attempts, 3);
  assert.deepEqual(failures[0], {
    type: "event-delivery-failed",
    service: "order-orchestrator",
    target: "http://payment-worker:8080/events",
    event_id: "event-1",
    correlation_id: "correlation-1",
    attempts: 3,
    message: "offline",
  });
});
