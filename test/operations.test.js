import test from "node:test";
import assert from "node:assert/strict";
import { Operations } from "../src/operations.js";

test("measured failures consume budget and create one incident", async () => {
  let now = 1_000;
  const operations = new Operations({ minSamples: 2, consecutiveWindows: 2, errorRateLimit: 0.2, now: () => now++ });
  const observation = { source: "gateway", status: 500, durationMs: 900 };
  await operations.observe(observation);
  await operations.observe(observation);
  await operations.observe(observation);
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
});
