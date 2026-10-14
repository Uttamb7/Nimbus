import test from "node:test";
import assert from "node:assert/strict";
import { History } from "../src/history.js";
import { Operations, pollOutbox } from "../src/operations.js";

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
  assert.equal(incidents[0].baseline, null);
});

test("error budget burn rate follows the measured sample window", async () => {
  const operations = new Operations({ availabilityTarget: 0.5 });
  assert.equal(operations.metrics("gateway").errorBudgetBurnRate, 0);
  await operations.observe({ source: "gateway", status: 200, durationMs: 10 });
  assert.equal(operations.metrics("gateway").errorBudgetBurnRate, 0);
  await operations.observe({ source: "gateway", status: 500, durationMs: 10 });
  assert.equal(operations.metrics("gateway").errorBudgetBurnRate, 1);
});

test("incident captures the last measured compliant window", async () => {
  const operations = new Operations({ minSamples: 2, consecutiveWindows: 2, errorRateLimit: 0.2 });
  for (let index = 0; index < 2; index++) {
    await operations.observe({ source: "gateway", status: 200, durationMs: 10 });
  }
  for (let index = 0; index < 2; index++) {
    await operations.observe({ source: "gateway", status: 500, durationMs: 900 });
  }

  const incident = (await operations.incidents())[0];
  assert.deepEqual(incident.baseline, {
    requestCount: 2, errorRate: 0, p50LatencyMs: 10, p95LatencyMs: 10,
    p99LatencyMs: 10, availability: 1,
  });
  assert.deepEqual(incident.evidence, {
    requestCount: 4, errorRate: 0.5, p50LatencyMs: 10, p95LatencyMs: 900,
    p99LatencyMs: 900, availability: 0.5,
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

test("sustained stalled consumer opens and recovers one queue incident", async () => {
  let now = 1_000;
  const history = new History();
  const operations = new Operations({ history, queueWindows: 2, now: () => now++ });
  const stalled = { name: "nimbus.payment-worker", ready: 3, unacknowledged: 1, consumers: 0 };
  const healthy = { ...stalled, ready: 0, unacknowledged: 0, consumers: 1 };

  await operations.observeQueue(stalled, "payment-worker");
  await operations.observeQueue(healthy, "payment-worker");
  assert.equal((await history.incidents()).length, 0);
  await operations.observeQueue(stalled, "payment-worker");
  await operations.observeQueue(stalled, "payment-worker");
  await operations.observeQueue(stalled, "payment-worker");

  const [incident] = await history.incidents();
  assert.equal(incident.status, "OPEN");
  assert.equal(incident.suspectedService, "payment-worker");
  assert.deepEqual(incident.evidence, {
    queueReady: 3, queueUnacknowledged: 1, queueConsumers: 0,
  });
  assert.equal((await history.incidents()).length, 1);

  await operations.observeQueue(healthy, "payment-worker");
  await operations.observeQueue(stalled, "payment-worker");
  await operations.observeQueue(healthy, "payment-worker");
  assert.equal((await history.incident(incident.id)).status, "OPEN");
  await operations.observeQueue(healthy, "payment-worker");
  assert.equal((await history.incident(incident.id)).status, "RESOLVED");
  const [audit] = await history.auditLog();
  assert.deepEqual(
    { actor: audit.actor, action: audit.action, resourceId: audit.resourceId },
    { actor: "nimbus-system", action: "incident.resolved", resourceId: incident.id },
  );
  assert.deepEqual(JSON.parse(audit.metadata), {
    reason: "queue consumer recovered", queue: stalled.name, consecutiveWindows: 2,
  });

  await operations.observeQueue(stalled, "payment-worker");
  await operations.observeQueue(stalled, "payment-worker");
  assert.equal((await history.incidents()).length, 2);
});

test("sustained dead-letter backlog opens and recovers one delivery incident", async () => {
  let now = 1_000;
  const history = new History();
  const operations = new Operations({ history, queueWindows: 2, now: () => now++ });
  const failed = { name: "nimbus.dead-letter", ready: 2, unacknowledged: 0, consumers: 0 };
  const drained = { ...failed, ready: 0 };

  await operations.observeDeadLetters(failed);
  await operations.observeDeadLetters(drained);
  await operations.observeDeadLetters(failed);
  assert.equal((await history.incidents()).length, 0);
  await operations.observeDeadLetters(failed);
  await operations.observeDeadLetters(failed);

  const [incident] = await history.incidents();
  assert.equal(incident.status, "OPEN");
  assert.equal(incident.suspectedService, "event-delivery");
  assert.match(incident.triggerCondition, /dead-letter/);
  assert.deepEqual(incident.evidence, {
    queueReady: 2, queueUnacknowledged: 0, queueConsumers: 0,
  });
  assert.equal((await history.incidents()).length, 1);

  await operations.observeDeadLetters(drained);
  await operations.observeDeadLetters(failed);
  await operations.observeDeadLetters(drained);
  assert.equal((await history.incident(incident.id)).status, "OPEN");
  await operations.observeDeadLetters(drained);
  assert.equal((await history.incident(incident.id)).status, "RESOLVED");
  const [audit] = await history.auditLog();
  assert.deepEqual(
    { actor: audit.actor, action: audit.action, resourceId: audit.resourceId },
    { actor: "nimbus-system", action: "incident.resolved", resourceId: incident.id },
  );
  assert.deepEqual(JSON.parse(audit.metadata), {
    reason: "dead-letter queue drained", queue: failed.name, consecutiveWindows: 2,
  });
});

test("sustained producer dead letters open and recover one outbox incident", async () => {
  let now = 1_000;
  const history = new History();
  const operations = new Operations({ history, outboxWindows: 2, now: () => now++ });
  const failed = { pending: 2, publishing: 1, published: 7, deadLetter: 3, oldestUnsentAt: "2026-10-14T12:00:00.000Z" };
  const clear = { ...failed, pending: 0, publishing: 0, deadLetter: 0, oldestUnsentAt: null };

  await operations.observeOutbox(failed);
  await operations.observeOutbox(clear);
  await operations.observeOutbox(failed);
  assert.equal((await history.incidents()).length, 0);
  await operations.observeOutbox(failed);
  await operations.observeOutbox(failed);

  const [incident] = await history.incidents();
  assert.equal(incident.status, "OPEN");
  assert.equal(incident.suspectedService, "producer-delivery");
  assert.deepEqual(incident.evidence, {
    outboxPending: 2, outboxPublishing: 1, outboxPublished: 7,
    outboxDeadLetter: 3, oldestUnsentAt: "2026-10-14T12:00:00.000Z",
  });
  assert.equal((await history.incidents()).length, 1);

  await operations.observeOutbox(clear);
  await operations.observeOutbox(failed);
  await operations.observeOutbox(clear);
  assert.equal((await history.incident(incident.id)).status, "OPEN");
  await operations.observeOutbox(clear);
  assert.equal((await history.incident(incident.id)).status, "RESOLVED");
  const [audit] = await history.auditLog();
  assert.deepEqual(
    { actor: audit.actor, action: audit.action, resourceId: audit.resourceId },
    { actor: "nimbus-system", action: "incident.resolved", resourceId: incident.id },
  );
  assert.deepEqual(JSON.parse(audit.metadata), {
    reason: "producer outbox cleared", consecutiveWindows: 2,
  });
});

test("outbox polling ignores failed samples", async () => {
  const observed = [];
  const operations = { observeOutbox: async (state) => observed.push(state) };
  const state = { pending: 0, publishing: 0, published: 1, deadLetter: 0, oldestUnsentAt: null };
  await pollOutbox({ outboxState: async () => state }, operations);
  await pollOutbox({ outboxState: async () => { throw new Error("offline"); } }, operations);
  assert.deepEqual(observed, [state]);
});
