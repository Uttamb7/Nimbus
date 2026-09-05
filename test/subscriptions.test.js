import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createClient } from "graphql-ws";
import WebSocket from "ws";
import { attachSubscriptions } from "../src/subscriptions.js";
import { Operations } from "../src/operations.js";
import { Actions } from "../src/actions.js";
import { History } from "../src/history.js";
import { Topology } from "../src/topology.js";
import { LiveEvents } from "../src/live-events.js";
import { connectLive } from "../web/live.js";

async function fixture(t) {
  const topology = new Topology();
  const operations = new Operations({ minSamples: 1, consecutiveWindows: 1 });
  const server = createServer();
  const sockets = attachSubscriptions(server, { topology, operations, authTokens: "read:viewer:Reader,operate:operator:Operator,control:admin:Uttam Bhattarai" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.dispose()));
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `ws://127.0.0.1:${server.address().port}/graphql/ws`;
  const client = (token, options = {}) => {
    const value = createClient({ url, webSocketImpl: WebSocket, retryAttempts: 0, connectionParams: token === undefined ? {} : { authorization: `Bearer ${token}` }, ...options });
    clients.push(value);
    return value;
  };
  return { topology, operations, sockets, client, url };
}

test("GraphQL WebSocket authenticates all roles and returns state-change payloads", { timeout: 5_000 }, async (t) => {
  const { topology, operations, client } = await fixture(t);
  for (const token of [undefined, "wrong"]) {
    const stream = client(token).iterate({ query: "subscription { auditEventAdded { id } }" });
    await assert.rejects(stream.next(), (error) => error.code === 4403);
  }
  const streams = ["read", "operate", "control"].map((token) => client(token).iterate({ query: "subscription { auditEventAdded { id actor action resourceId metadata } }" }));
  for (const stream of streams) assert.deepEqual((await stream.next()).value.data, { auditEventAdded: null });
  const health = client("read").iterate({ query: "subscription { serviceHealthChanged { id name owner health metrics { requestCount errorRate } } }" });
  const incidents = client("read").iterate({ query: "subscription { incidentChanged { id status affectedServices createdAt acknowledgedAt resolvedAt } }" });
  assert.deepEqual((await health.next()).value.data, { serviceHealthChanged: null });
  assert.deepEqual((await incidents.next()).value.data, { incidentChanged: null });
  const observation = { source: "gateway", destination: "inventory-api", status: 503, durationMs: 900 };
  topology.observe(observation);
  await operations.observe(observation, { affectedServices: ["gateway", "inventory-api"] });
  const service = (await health.next()).value.data.serviceHealthChanged;
  assert.deepEqual(service, { id: "gateway", name: "gateway", owner: "Uttam Bhattarai", health: "CRITICAL", metrics: { requestCount: 1, errorRate: 1 } });
  const incident = (await incidents.next()).value.data.incidentChanged;
  assert.deepEqual(incident.affectedServices, ["gateway", "inventory-api"]);
  assert.equal(incident.status, "OPEN");
  const actions = new Actions(operations);
  const audit = await actions.acknowledgeIncident({ id: incident.id }, "Operator");
  assert.equal((await incidents.next()).value.data.incidentChanged.status, "ACKNOWLEDGED");
  for (const stream of streams) assert.deepEqual((await stream.next()).value.data.auditEventAdded, { id: audit.id, actor: "Operator", action: "incident.acknowledged", resourceId: incident.id, metadata: "{}" });
  await actions.resolveIncident({ id: incident.id }, "Operator");
  assert.equal((await incidents.next()).value.data.incidentChanged.status, "RESOLVED");
});

test("WebSocket query guards prevent mutations, malformed and oversized operations", { timeout: 5_000 }, async (t) => {
  const { client, operations } = await fixture(t);
  const viewer = client("read");
  for (const [query, message] of [
    ["mutation { generateTraffic { id } }", /use HTTP/],
    ["subscription { missing }", /Cannot query field/],
    ["subscription {", /Syntax Error/],
    [`subscription { auditEventAdded { ${Array.from({ length: 201 }, (_, i) => `a${i}: id`).join(" ")} } }`, /complexity/],
    [" ".repeat(10_001), /invalid query/],
  ]) {
    await assert.rejects(viewer.iterate({ query }).next(), (errors) => message.test(errors[0].message));
  }
  assert.deepEqual(await operations.history.auditLog(), []);
  const streams = Array.from({ length: 8 }, () => viewer.iterate({ query: "subscription { auditEventAdded { id } }" }));
  for (const stream of streams) await stream.next();
  await assert.rejects(viewer.iterate({ query: "subscription { auditEventAdded { id } }" }).next(), (errors) => /subscription limit/.test(errors[0].message));
});

test("disconnected and overflowing subscriptions release queues without blocking observations", { timeout: 5_000 }, async (t) => {
  const { client, operations, sockets } = await fixture(t);
  const connection = client("read");
  const stream = connection.iterate({ query: "subscription { serviceHealthChanged { name } }" });
  await stream.next();
  assert.equal(operations.history.events.size, 1);
  await stream.return();
  await connection.dispose();
  for (let attempt = 0; attempt < 100 && operations.history.events.size; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(operations.history.events.size, 0);

  let overflowed = false;
  const slow = operations.history.events.subscribe("serviceHealthChanged", () => { overflowed = true; });
  await slow.next();
  for (let index = 0; index < 100; index++) await operations.observe({ source: "gateway", status: 200, durationMs: 10 });
  assert.equal(operations.metrics("gateway").requestCount, 100);
  assert.equal(operations.history.events.size, 0);
  assert.equal(overflowed, true);
  assert.equal((await slow.next()).done, true);

  const idle = new LiveEvents().subscribe("auditEventAdded");
  await idle.next();
  const pending = idle.next();
  await idle.return();
  assert.equal((await pending).done, true);

  const slowConnection = client("read");
  await slowConnection.iterate({ query: "subscription { serviceHealthChanged { name } }" }).next();
  const socket = [...sockets.clients][0];
  const closed = once(socket, "close");
  for (let index = 0; index < 100; index++) operations.observe({ source: "gateway", status: 200, durationMs: 10 });
  await closed;
  assert.equal(operations.history.events.size, 0, "overflow must disconnect and remove the real socket subscriber");
});

test("console re-registers real WebSocket subscriptions after transport loss", { timeout: 8_000 }, async (t) => {
  const { operations, sockets, url } = await fixture(t);
  const states = [];
  let snapshots = 0;
  const live = connectLive({ url, authorization: "Bearer read", createClient: (options) => createClient({ ...options, webSocketImpl: WebSocket }), refresh: async () => { snapshots++; }, onState: (state) => states.push(state) });
  t.after(() => live.stop());
  const wait = async (predicate) => {
    for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(predicate(), true);
  };
  await wait(() => states.at(-1) === "LIVE");
  assert.equal(operations.history.events.size, 3);
  const before = snapshots;
  for (const socket of sockets.clients) socket.terminate();
  await wait(() => states.includes("RECONNECTING · POLLING"));
  await wait(() => states.at(-1) === "LIVE");
  assert.ok(snapshots > before, "reconnect must fetch a fresh snapshot");
  assert.equal(operations.history.events.size, 3, "reconnect must not leak duplicate subscribers");
  live.stop();
  await wait(() => operations.history.events.size === 0);
});

test("incident and audit notifications wait for successful storage writes", async () => {
  let finish;
  const history = new History({ pool: { query: () => new Promise((resolve, reject) => { finish = { resolve, reject }; }) } });
  const incidentStream = history.events.subscribe("incidentChanged");
  const auditStream = history.events.subscribe("auditEventAdded");
  await incidentStream.next(); await auditStream.next();
  let delivered = false;
  const pending = incidentStream.next().then((value) => { delivered = true; return value; });
  const incident = { id: "incident", severity: "SEV2", status: "OPEN", title: "Failure", suspectedService: "gateway", triggerCondition: "error rate", createdAt: "2026-08-31T12:00:00Z" };
  const row = { ...incident, suspected_service: "gateway", trigger_condition: "error rate", created_at: incident.createdAt };
  const create = history.createIncident(incident);
  assert.equal(delivered, false);
  finish.resolve({ rows: [row] });
  await create;
  assert.equal((await pending).value.incidentChanged.id, "incident");
  const update = history.updateIncident("incident", "ACKNOWLEDGED", incident.createdAt);
  finish.resolve({ rows: [{ ...row, status: "ACKNOWLEDGED", acknowledged_at: incident.createdAt }] });
  await update;
  assert.equal((await incidentStream.next()).value.incidentChanged.status, "ACKNOWLEDGED");
  const audit = { id: "audit", timestamp: incident.createdAt, actor: "Operator", action: "incident.acknowledged", resource: "incident", resourceId: "incident", metadata: "{}" };
  const append = history.appendAudit(audit);
  finish.resolve({ rows: [{ ...audit, recorded_at: audit.timestamp, resource_id: "incident", metadata: {} }] });
  await append;
  assert.equal((await auditStream.next()).value.auditEventAdded.id, "audit");

  for (const write of [() => history.createIncident(incident), () => history.updateIncident("incident", "RESOLVED", incident.createdAt), () => history.appendAudit(audit)]) {
    const failed = write();
    finish.reject(new Error("database unavailable"));
    await assert.rejects(failed, /database unavailable/);
  }
  const duplicate = history.createIncident(incident);
  finish.resolve({ rows: [] }); await duplicate;
  const missing = history.updateIncident("missing", "RESOLVED", incident.createdAt);
  finish.resolve({ rows: [] }); await missing;
  // Returning a drained iterator proves failed/no-op writes left no queued event.
  let unexpected = false;
  const noIncident = incidentStream.next().then((item) => { unexpected ||= !item.done; });
  const noAudit = auditStream.next().then((item) => { unexpected ||= !item.done; });
  await incidentStream.return(); await auditStream.return();
  await Promise.all([noIncident, noAudit]);
  assert.equal(unexpected, false);
});
