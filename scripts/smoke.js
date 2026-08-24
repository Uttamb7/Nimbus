import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

async function graphql(query, variables, token = "local-viewer") {
  const response = await fetch("http://127.0.0.1:4000/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const result = await response.json();
  assert.deepEqual(result.errors, undefined);
  return result.data;
}

const checkout = await fetch("http://127.0.0.1:8080/checkout", {
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": "ci-checkout" },
  body: JSON.stringify({ sku: "ci-demo", quantity: 1 }),
});
assert.equal(checkout.status, 202);
const order = await checkout.json();
assert.ok(order.orderId);
assert.ok(order.correlationId);

let outbox = "";
for (let attempt = 0; attempt < 20; attempt++) {
  outbox = execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "nimbus", "-d", "nimbus", "-Atc", `SELECT status || '|' || (event->>'type') || '|' || (event->>'version') FROM outbox_events WHERE aggregate_id = '${order.orderId}'`], { encoding: "utf8" }).trim();
  if (outbox.startsWith("PUBLISHED|")) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
assert.equal(outbox, "PUBLISHED|order.created|1");

const event = JSON.parse(execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "nimbus", "-d", "nimbus", "-Atc", `SELECT event::text FROM outbox_events WHERE aggregate_id = '${order.orderId}'`], { encoding: "utf8" }));
execFileSync("docker", ["compose", "restart", "payment-worker"], { stdio: "inherit" });
const duplicate = JSON.parse(execFileSync("docker", ["compose", "exec", "-T", "order-orchestrator", "node", "-e", `
  (async () => {
    const event = ${JSON.stringify(event)};
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await fetch("http://payment-worker:8080/events", { method: "POST", body: JSON.stringify(event) });
        if (response.ok) { console.log(JSON.stringify({ status: response.status, body: await response.json() })); return; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    process.exit(1);
  })();
`], { encoding: "utf8" }));
assert.deepEqual(duplicate, { status: 200, body: { duplicate: true } });
const receiptCount = Number(execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "nimbus", "-d", "nimbus", "-Atc", `SELECT count(*) FROM consumer_receipts WHERE consumer_name = 'payment-worker' AND event_id = '${event.eventId}'`], { encoding: "utf8" }).trim());
assert.equal(receiptCount, 1);

const query = "{ serviceGraph { source destination requestCount errorCount averageLatencyMs } }";
let edges = [];
for (let attempt = 0; attempt < 20; attempt++) {
  edges = (await graphql(query)).serviceGraph;
  if (edges.length >= 3) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

for (const dependency of ["gateway->identity-api", "gateway->order-orchestrator", "order-orchestrator->inventory-api"]) {
  assert.ok(edges.some((edge) => `${edge.source}->${edge.destination}` === dependency), `missing observed edge ${dependency}`);
}
assert.ok(edges.every((edge) => edge.requestCount > 0 && edge.averageLatencyMs >= 0));

for (let index = 0; index < 7; index++) {
  const response = await fetch("http://127.0.0.1:4000/observe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "gateway", destination: "inventory-api", status: 503, durationMs: 1_000 }),
  });
  assert.equal(response.status, 202);
}

const beforeRestart = await graphql("{ incidents { id status createdAt } }");
const incident = beforeRestart.incidents.find((value) => value.status === "OPEN");
assert.ok(incident);
await graphql("mutation($id: ID!) { acknowledgeIncident(id: $id) { action resourceId } }", { id: incident.id }, "local-operator");
await graphql("mutation($id: ID!) { resolveIncident(id: $id) { action resourceId } }", { id: incident.id }, "local-operator");

execFileSync("docker", ["compose", "restart", "control-plane"], { stdio: "inherit" });
let ready = false;
for (let attempt = 0; attempt < 40; attempt++) {
  try {
    ready = (await fetch("http://127.0.0.1:4000/health")).ok;
  } catch {}
  if (ready) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
assert.equal(ready, true, "control plane did not recover after restart");

const persisted = await graphql("{ incidents { id status createdAt acknowledgedAt resolvedAt } auditLog { action resourceId } }");
assert.ok(persisted.incidents.some((value) => value.id === incident.id && value.status === "RESOLVED" && value.createdAt === incident.createdAt && value.acknowledgedAt && value.resolvedAt));
assert.ok(persisted.auditLog.some((value) => value.action === "incident.acknowledged" && value.resourceId === incident.id));
assert.ok(persisted.auditLog.some((value) => value.action === "incident.resolved" && value.resourceId === incident.id));
console.log(`checkout ${order.orderId}: durable event published and duplicate suppressed after consumer restart; ${edges.length} observed edges; incident ${incident.id} survived restart`);
