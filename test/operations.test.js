import test from "node:test";
import assert from "node:assert/strict";
import { History } from "../src/history.js";
import { Operations, pollOutbox } from "../src/operations.js";

test("measured failures consume budget and create trigger-specific incidents", async () => {
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
  assert.deepEqual(incidents.map((incident) => incident.triggerCondition).sort(), [
    "error budget burn rate exceeded 14.4×", "error rate exceeded 20%",
    "p95 latency exceeded 800 ms",
  ]);
  for (const incident of incidents) {
    assert.deepEqual(incident.affectedServices, ["gateway", "orders", "inventory"]);
    assert.deepEqual({ ...incident.evidence, errorBudgetBurnRate: undefined }, {
      requestCount: 3, errorRate: 1, p50LatencyMs: 900, p95LatencyMs: 900,
      p99LatencyMs: 900, availability: 0, errorBudgetRemaining: 0,
      errorBudgetBurnRate: undefined,
    });
    assert.ok(incident.evidence.errorBudgetBurnRate > 999);
    assert.equal(incident.baseline, null);
  }
});

test("error budget burn rate follows the measured sample window", async () => {
  const operations = new Operations({ availabilityTarget: 0.5 });
  assert.equal(operations.metrics("gateway").errorBudgetBurnRate, 0);
  await operations.observe({ source: "gateway", status: 200, durationMs: 10 });
  assert.equal(operations.metrics("gateway").errorBudgetBurnRate, 0);
  await operations.observe({ source: "gateway", status: 500, durationMs: 10 });
  assert.equal(operations.metrics("gateway").errorBudgetBurnRate, 1);
});

test("fast error-budget burn opens, deduplicates, and recovers independently", async () => {
  let now = 1_000;
  const history = new History();
  const operations = new Operations({
    history, availabilityTarget: 0.5, errorBudgetBurnRateLimit: 0.5,
    errorRateLimit: 0.9, p95LimitMs: 1_000, minSamples: 2,
    consecutiveWindows: 2, recoveryWindows: 2, now: () => now++,
  });
  const healthy = { source: "gateway", status: 200, durationMs: 10 };
  const failed = { source: "gateway", status: 500, durationMs: 10 };

  await operations.observe(failed);
  await operations.observe(healthy);
  await operations.observe(healthy);
  await operations.observe(failed);

  let incidents = await history.incidents();
  assert.equal(incidents.length, 1);
  assert.match(incidents[0].triggerCondition, /error budget burn rate/);
  assert.equal(incidents[0].status, "OPEN");
  assert.equal(incidents[0].evidence.errorBudgetBurnRate, 2 / 3);
  assert.ok(Math.abs(incidents[0].evidence.errorBudgetRemaining - 1 / 3) < 1e-12);

  for (let index = 0; index < 5; index++) await operations.observe(healthy);
  incidents = await history.incidents();
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].status, "RESOLVED");
  const [audit] = await history.auditLog();
  assert.deepEqual(JSON.parse(audit.metadata), {
    reason: "measured recovery", consecutiveWindows: 2,
  });
});

test("expired samples reset fast-burn detection without resolving history", async () => {
  let now = 0;
  const history = new History();
  const operations = new Operations({
    history, availabilityTarget: 0.5, errorBudgetBurnRateLimit: 0.5,
    errorRateLimit: 0.9, p95LimitMs: 1_000, minSamples: 2,
    consecutiveWindows: 2, sampleMaxAgeMs: 10, now: () => now,
  });
  const healthy = { source: "gateway", status: 200, durationMs: 10 };
  const failed = { source: "gateway", status: 500, durationMs: 10 };

  await operations.observe(failed);
  await operations.observe(healthy);
  now = 11;
  operations.metrics("gateway");
  await operations.observe(failed);
  now = 12;
  await operations.observe(healthy);
  assert.equal((await history.incidents()).length, 0);
  now = 13;
  await operations.observe(healthy);
  assert.equal((await history.incidents()).length, 1);

  now = 30;
  operations.metrics("gateway");
  assert.equal((await history.incidents())[0].status, "OPEN");
});

test("service metrics expire stale samples and restart detection state", async () => {
  let now = 0;
  const operations = new Operations({
    minSamples: 2, consecutiveWindows: 2, errorRateLimit: 0.2,
    errorBudgetBurnRateLimit: Infinity, sampleMaxAgeMs: 100, now: () => now,
  });
  const failed = { source: "gateway", status: 500, durationMs: 900 };

  await operations.observe(failed);
  now = 100;
  await operations.observe(failed);
  assert.equal(operations.metrics("gateway").requestCount, 2);

  now = 101;
  const current = operations.metrics("gateway");
  assert.equal(current.requestCount, 1);
  assert.equal(current.errorRate, 1);
  assert.equal(current.p95LatencyMs, 900);
  assert.equal(current.health, "DEGRADED");
  now = 201;
  assert.deepEqual(operations.metrics("gateway"), {
    requestCount: 0, requestRate: 0, errorRate: 0,
    p50LatencyMs: 0, p95LatencyMs: 0, p99LatencyMs: 0,
    availability: 0, sloCompliance: false, errorBudgetRemaining: 0,
    errorBudgetBurnRate: 0, health: "UNKNOWN",
  });

  now = 202;
  await operations.observe(failed);
  now = 203;
  await operations.observe(failed);
  assert.equal((await operations.incidents()).length, 0);
  now = 204;
  await operations.observe(failed);
  assert.equal((await operations.incidents()).length, 2);
});

test("incident captures the last measured compliant window", async () => {
  const operations = new Operations({ minSamples: 2, consecutiveWindows: 2, errorRateLimit: 0.2, errorBudgetBurnRateLimit: Infinity });
  for (let index = 0; index < 2; index++) {
    await operations.observe({ source: "gateway", status: 200, durationMs: 10 });
  }
  for (let index = 0; index < 2; index++) {
    await operations.observe({ source: "gateway", status: 500, durationMs: 900 });
  }

  const incident = (await operations.incidents())[0];
  assert.deepEqual(incident.baseline, {
    requestCount: 2, errorRate: 0, p50LatencyMs: 10, p95LatencyMs: 10,
    p99LatencyMs: 10, availability: 1, errorBudgetRemaining: 1,
    errorBudgetBurnRate: 0,
  });
  assert.deepEqual(incident.evidence, {
    requestCount: 4, errorRate: 0.5, p50LatencyMs: 10, p95LatencyMs: 900,
    p99LatencyMs: 900, availability: 0.5, errorBudgetRemaining: 0,
    errorBudgetBurnRate: 0.5 / (1 - 0.999),
  });
});

test("sustained measured recovery resolves an incident exactly once", async () => {
  let now = 1_000;
  const history = new History();
  await history.createIncident({ id: "incident", severity: "SEV2", status: "OPEN", title: "gateway is unhealthy", suspectedService: "gateway", triggerCondition: "error rate exceeded 20%", createdAt: new Date(now++).toISOString(), acknowledgedAt: null, resolvedAt: null });
  const operations = new Operations({ history, minSamples: 1, errorRateLimit: 0.2, errorBudgetBurnRateLimit: Infinity, p95LimitMs: 1_000, recoveryWindows: 3, now: () => now++ });

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

test("latency and error incidents recover independently", async () => {
  let now = 0;
  const history = new History();
  const operations = new Operations({
    history, minSamples: 1, consecutiveWindows: 2, recoveryWindows: 2,
    errorRateLimit: 0.2, errorBudgetBurnRateLimit: Infinity,
    p95LimitMs: 100, sampleMaxAgeMs: 10, now: () => now,
  });

  await operations.observe({ source: "gateway", status: 500, durationMs: 200 });
  await operations.observe({ source: "gateway", status: 500, durationMs: 200 });
  let incidents = await history.incidents();
  assert.equal(incidents.filter((incident) => incident.status === "OPEN").length, 2);

  now = 20;
  await operations.observe({ source: "gateway", status: 500, durationMs: 10 });
  now = 21;
  await operations.observe({ source: "gateway", status: 500, durationMs: 10 });
  incidents = await history.incidents();
  assert.equal(incidents.find((incident) => incident.triggerCondition.startsWith("p95")).status, "RESOLVED");
  assert.equal(incidents.find((incident) => incident.triggerCondition.startsWith("error")).status, "OPEN");
  assert.equal((await history.auditLog()).length, 1);

  now = 40;
  await operations.observe({ source: "gateway", status: 200, durationMs: 10 });
  now = 41;
  await operations.observe({ source: "gateway", status: 200, durationMs: 10 });
  incidents = await history.incidents();
  assert.equal(incidents.filter((incident) => incident.status === "RESOLVED").length, 2);
  assert.equal((await history.auditLog()).length, 2);
});

test("measured recovery cannot resolve a queue incident for the same service", async () => {
  const history = new History();
  const operations = new Operations({
    history, minSamples: 1, recoveryWindows: 1, queueWindows: 1,
  });
  const stalled = { name: "nimbus.payment-worker", ready: 1, unacknowledged: 0, consumers: 0 };
  await operations.observeQueue(stalled, "payment-worker");
  const [incident] = await history.incidents();

  await operations.observe({ source: "payment-worker", status: 200, durationMs: 1 });
  assert.equal((await history.incident(incident.id)).status, "OPEN");
  assert.equal((await history.auditLog()).length, 0);

  await operations.observeQueue({ ...stalled, ready: 0, consumers: 1 }, "payment-worker");
  assert.equal((await history.incident(incident.id)).status, "RESOLVED");
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

test("stuck unacknowledged deliveries open and recover one matching incident", async () => {
  let now = 1_000;
  const history = new History();
  const operations = new Operations({ history, queueWindows: 2, now: () => now++ });
  const stuck = {
    name: "nimbus.payment-worker", ready: 0, unacknowledged: 2, consumers: 1, ackRate: 0,
  };
  const progressing = { ...stuck, ackRate: 0.5 };

  await operations.observeQueue(stuck, "payment-worker");
  await operations.observeQueue(progressing, "payment-worker");
  await operations.observeQueue(stuck, "payment-worker");
  assert.equal((await history.incidents()).length, 0);
  await operations.observeQueue(stuck, "payment-worker");
  await operations.observeQueue(stuck, "payment-worker");

  const [incident] = await history.incidents();
  assert.equal(incident.status, "OPEN");
  assert.match(incident.triggerCondition, /acknowledgement progress/);
  assert.deepEqual(incident.evidence, {
    queueReady: 0, queueUnacknowledged: 2, queueConsumers: 1,
  });
  assert.equal((await history.incidents()).length, 1);

  await operations.observeQueue(progressing, "payment-worker");
  await operations.observeQueue(stuck, "payment-worker");
  await operations.observeQueue(progressing, "payment-worker");
  assert.equal((await history.incident(incident.id)).status, "OPEN");
  await operations.observeQueue({ ...stuck, unacknowledged: 0 }, "payment-worker");
  assert.equal((await history.incident(incident.id)).status, "RESOLVED");
  const [audit] = await history.auditLog();
  assert.deepEqual(
    { actor: audit.actor, action: audit.action, resourceId: audit.resourceId },
    { actor: "nimbus-system", action: "incident.resolved", resourceId: incident.id },
  );
  assert.deepEqual(JSON.parse(audit.metadata), {
    reason: "queue acknowledgements recovered",
    queue: stuck.name,
    consecutiveWindows: 2,
  });
});

test("idle consumer with ready work opens and recovers only its matching incident", async () => {
  let now = 1_000;
  const history = new History();
  const operations = new Operations({ history, queueWindows: 2, now: () => now++ });
  const idle = {
    name: "nimbus.payment-worker", ready: 3, unacknowledged: 0, consumers: 1,
    publishRate: 0, ackRate: 0,
  };
  const progressing = { ...idle, ackRate: 0.5 };
  const inFlight = { ...idle, ready: 2, unacknowledged: 1 };

  await operations.observeQueue(idle, "payment-worker");
  await operations.observeQueue(progressing, "payment-worker");
  await operations.observeQueue(idle, "payment-worker");
  assert.equal((await history.incidents()).length, 0);
  await operations.observeQueue(idle, "payment-worker");
  await operations.observeQueue(idle, "payment-worker");

  const [incident] = await history.incidents();
  assert.equal(incident.status, "OPEN");
  assert.match(incident.triggerCondition, /not accepting/);
  assert.deepEqual(incident.evidence, {
    queueReady: 3, queueUnacknowledged: 0, queueConsumers: 1, queueAckRate: 0,
  });

  await operations.observeQueue(progressing, "payment-worker");
  await operations.observeQueue(idle, "payment-worker");
  assert.equal((await history.incident(incident.id)).status, "OPEN");
  await operations.observeQueue(inFlight, "payment-worker");
  await operations.observeQueue(inFlight, "payment-worker");

  const incidents = await history.incidents();
  assert.equal((await history.incident(incident.id)).status, "RESOLVED");
  assert.equal(incidents.filter((item) => item.triggerCondition === incident.triggerCondition).length, 1);
  assert.equal(incidents.filter((item) => item.status === "OPEN").length, 1);
  assert.match(incidents.find((item) => item.status === "OPEN").triggerCondition, /acknowledgement progress/);
  const [audit] = await history.auditLog();
  assert.deepEqual(JSON.parse(audit.metadata), {
    reason: "queue consumer accepted work", queue: idle.name, consecutiveWindows: 2,
  });
});

test("growing consumer backlog opens and recovers one matching incident", async () => {
  let now = 1_000;
  const history = new History();
  const operations = new Operations({ history, queueWindows: 2, now: () => now++ });
  const growing = {
    name: "nimbus.payment-worker", ready: 3, unacknowledged: 1, consumers: 1,
    publishRate: 2, ackRate: 1,
  };
  const keepingPace = { ...growing, publishRate: 1 };

  await operations.observeQueue(growing, "payment-worker");
  await operations.observeQueue(keepingPace, "payment-worker");
  await operations.observeQueue(growing, "payment-worker");
  assert.equal((await history.incidents()).length, 0);
  await operations.observeQueue(growing, "payment-worker");
  await operations.observeQueue(growing, "payment-worker");

  const [incident] = await history.incidents();
  assert.equal(incident.status, "OPEN");
  assert.match(incident.triggerCondition, /publishes faster/);
  assert.deepEqual(incident.evidence, {
    queueReady: 3, queueUnacknowledged: 1, queueConsumers: 1,
    queuePublishRate: 2, queueAckRate: 1,
  });

  await operations.observeQueue(keepingPace, "payment-worker");
  await operations.observeQueue(growing, "payment-worker");
  await operations.observeQueue(keepingPace, "payment-worker");
  assert.equal((await history.incident(incident.id)).status, "OPEN");
  await operations.observeQueue({ ...keepingPace, ready: 0 }, "payment-worker");
  assert.equal((await history.incident(incident.id)).status, "RESOLVED");
  const [audit] = await history.auditLog();
  assert.deepEqual(JSON.parse(audit.metadata), {
    reason: "queue backlog recovered", queue: growing.name, consecutiveWindows: 2,
  });
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
    reason: "producer outbox recovered", consecutiveWindows: 2,
  });
});

test("sustained producer delay opens one incident across failure states", async () => {
  let now = Date.parse("2026-10-15T12:02:00.000Z");
  const history = new History();
  const operations = new Operations({
    history, outboxWindows: 2, outboxDelayMs: 60_000, now: () => now,
  });
  const delayed = {
    pending: 2, publishing: 0, published: 7, deadLetter: 0,
    oldestUnsentAt: "2026-10-15T12:00:00.000Z",
  };
  const fresh = { ...delayed, oldestUnsentAt: "2026-10-15T12:01:30.000Z" };

  await operations.observeOutbox(delayed);
  await operations.observeOutbox(fresh);
  await operations.observeOutbox(delayed);
  assert.equal((await history.incidents()).length, 0);
  await operations.observeOutbox(delayed);

  const [incident] = await history.incidents();
  assert.equal(incident.status, "OPEN");
  assert.match(incident.triggerCondition, /dead-letter or delayed/);
  assert.deepEqual(incident.evidence, {
    outboxPending: 2, outboxPublishing: 0, outboxPublished: 7,
    outboxDeadLetter: 0, oldestUnsentAt: delayed.oldestUnsentAt,
  });

  const deadLetter = { ...delayed, pending: 0, deadLetter: 1 };
  await operations.observeOutbox(deadLetter);
  await operations.observeOutbox(deadLetter);
  assert.equal((await history.incidents()).length, 1);
  assert.equal((await history.incident(incident.id)).status, "OPEN");

  now += 1;
  await operations.observeOutbox(fresh);
  await operations.observeOutbox(fresh);
  assert.equal((await history.incident(incident.id)).status, "RESOLVED");
  assert.equal((await history.auditLog()).length, 1);
});

test("producer delay ignores active samples without a usable timestamp", async () => {
  const history = new History();
  const operations = new Operations({ history, outboxWindows: 1 });
  await operations.observeOutbox({
    pending: 1, publishing: 0, published: 0, deadLetter: 0, oldestUnsentAt: "invalid",
  });
  assert.equal((await history.incidents()).length, 0);
});

test("outbox polling ignores failed samples", async () => {
  const observed = [];
  const operations = { observeOutbox: async (state) => observed.push(state) };
  const state = { pending: 0, publishing: 0, published: 1, deadLetter: 0, oldestUnsentAt: null };
  await pollOutbox({ outboxState: async () => state }, operations);
  await pollOutbox({ outboxState: async () => { throw new Error("offline"); } }, operations);
  assert.deepEqual(observed, [state]);
});
