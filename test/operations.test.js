import test from "node:test";
import assert from "node:assert/strict";
import { History } from "../src/history.js";
import { Operations } from "../src/operations.js";

test("measured failures consume budget and create one incident", async () => {
  let now = 1_000;
  const operations = new Operations({ minSamples: 2, consecutiveWindows: 2, errorRateLimit: 0.2, now: () => now++ });
  const observation = { source: "gateway", status: 500, durationMs: 900 };
  await operations.observe(observation);
  await operations.observe(observation);
  await operations.observe(observation, { affectedServices: ["gateway", "orders", "inventory"] });
  await operations.observe(observation);
  const metrics = operations.metrics("gateway");
  assert.equal(metrics.requestCount, 4);
  assert.equal(metrics.errorRate, 1);
  assert.equal(metrics.p95LatencyMs, 900);
  assert.equal(metrics.health, "CRITICAL");
  assert.equal(metrics.errorBudgetRemaining, 0);
  const incidents = await operations.incidents();
  assert.equal(incidents.length, 1);
  assert.match(incidents[0].triggerCondition, /p95 latency/);
  assert.deepEqual(incidents[0].affectedServices, ["gateway", "orders", "inventory"]);
  assert.deepEqual(incidents[0].evidence, {
    requestCount: 3, errorRate: 1, p50LatencyMs: 900, p95LatencyMs: 900,
    p99LatencyMs: 900, availability: 0,
  });
});

test("sustained measured recovery resolves an incident exactly once", async () => {
  let now = 1_000;
  const history = new History();
  await history.createIncident({ id: "incident", severity: "SEV2", status: "OPEN", title: "gateway is unhealthy", suspectedService: "gateway", triggerCondition: "error rate", createdAt: new Date(now++).toISOString(), acknowledgedAt: null, resolvedAt: null });
  const operations = new Operations({ history, minSamples: 1, errorRateLimit: 0.2, p95LimitMs: 1_000, recoveryWindows: 3, now: () => now++ });

  await operations.observe({ source: "gateway", status: 200, durationMs: 10 });
  await operations.observe({ source: "gateway", status: 200, durationMs: 10 });
  await operations.observe({ source: "gateway", status: 500, durationMs: 10 });
  for (let index = 0; index < 3; index++) await operations.observe({ source: "gateway", status: 200, durationMs: 10 });
  assert.equal((await history.incident("incident")).status, "OPEN");

  await operations.observe({ source: "gateway", status: 200, durationMs: 10 });
  assert.equal((await history.incident("incident")).status, "RESOLVED");
  const audit = await history.auditLog();
  assert.equal(audit.length, 1);
  assert.deepEqual({ actor: audit[0].actor, action: audit[0].action, resourceId: audit[0].resourceId }, { actor: "nimbus-system", action: "incident.resolved", resourceId: "incident" });
  assert.deepEqual(JSON.parse(audit[0].metadata), { reason: "measured recovery", consecutiveWindows: 3 });

  for (let index = 0; index < 3; index++) await operations.observe({ source: "gateway", status: 200, durationMs: 10 });
  assert.equal((await history.auditLog()).length, 1);
});
